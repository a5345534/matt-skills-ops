import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MattAutoLogger } from "./adapters/logger.js";
import {
  checkCiActionId,
  CI_RECOVERY_OPTIONS,
  ciRecoveryActionId,
  CLEANUP_WORKFLOW_ACTION,
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_COORDINATION_LEASE_TTL_MS,
  DEFAULT_REPOSITORY_SCHEDULER_LEASE_TTL_MS,
  DEFAULT_TARGET_BRANCH,
  dispositionActionId,
  IMPLEMENTATION_DISPOSITION_OPTIONS,
  filterWorkflowOwnedBranches,
  implementTicketActionId,
  implementationBranchName,
  integrateTicketActionId,
  integrationBranchName,
  MERGE_WORKFLOW_PR_ACTION,
  NO_GIT_REPOSITORY_REASON,
  OPEN_WORKFLOW_PR_ACTION,
  REFRESH_FROM_TARGET_ACTION,
  parseCheckCiActionId,
  parseCiRecoveryActionId,
  parseDispositionActionId,
  parseImplementTicketActionId,
  parseIntegrateTicketActionId,
  parseReworkTicketActionId,
  parseResumeWorkflowActionId,
  REQUIRED_MATT_SKILLS,
  reworkTicketActionId,
  resumeWorkflowActionId,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
  START_FOLLOW_UP_ACTION,
  START_NEW_INDEPENDENT_WORKFLOW_ACTION,
  TICKET_ISSUE_LABEL,
  REWORK_TICKET_ACTION_PREFIX,
  TICKET_PROGRESS_ACTION,
  UNSUPPORTED_TRACKER_REASON,
  WORKFLOW_MANIFEST_SCHEMA,
} from "./constants.js";
import {
  canonicalRepositoryIdentityKey,
  canonicalTargetIdentityKey,
  isCanonicalRepositoryIdentity,
  targetBranchFromRef,
  targetRefFromBranch,
} from "./coordination.js";
import { isPublishableSpecDraft } from "./adapters/planning-draft.js";
import { gcMattAutoGitlinkArtifacts } from "./adapters/gitlink-cleanup.js";
import { ensureSubmoduleGitlinksPublished } from "./adapters/submodule-gate.js";
import {
  assertValidWorkerConcurrency,
  assertValidLiveWaitPollIntervalMs,
  resolveEffectiveWorkerConcurrency,
  resolveLiveWaitPollInterval,
} from "./adapters/preferences.js";
import {
  getTrackerGhMetrics,
  graphqlBackoffRemainingMs,
  isInGraphqlBackoff,
} from "./adapters/tracker-rate-limit.js";
import { listLocalUnfinishedWorkflows as scanLocalUnfinishedWorkflows } from "./adapters/local-workflow-index.js";
import { workerTranscriptPath } from "./adapters/transcripts.js";
import { implementationWorktreePath } from "./adapters/workspace.js";
import {
  computeImplementationSlots,
  countRunningImplementationWorkers,
  implementationLaunchBlockReason,
  runningTicketsBlockedByOpen,
} from "./launch-rules.js";
import {
  planRepositoryWorkerSlots,
  type OccupiedRepositoryWorkerSlot,
  type RepositoryWorkerDemand,
  type RepositoryWorkerSlotPlan,
} from "./worker-capacity.js";
import {
  createTargetBranchQueueOrchestrator,
  type TargetBranchQueueOrchestrator,
} from "./target-branch-queue.js";
import {
  mergeTargetIntoIntegration,
  recordTargetRefreshFailure,
  refreshedWorkflowPrFreshness,
  releaseTargetRefreshForPrChecks,
  TARGET_REFRESH_FAILURE_REASONS,
  TARGET_REFRESH_TRANSCRIPT_TICKET,
  targetRefreshConflictSkillInput,
  ticketIntegrationConflictSkillInput,
  type TargetRefreshConflict,
} from "./target-refresh.js";
import type {
  RootScopedPorts,
  TrackerTicket,
  WorkerEventSink,
  WorkflowCoordinatorPorts,
} from "./ports.js";
import { buildParallelDeliveryPanelState } from "./parallel-delivery-state.js";
import {
  evaluateMergeFreshness,
  evaluateProtectedBranchAutomation,
  policyRequiresStatusChecks,
  type ProtectedBranchAutomationPolicy,
} from "./workflow-pr-guard.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  CompletedWorkerTelemetry,
  CiRecoveryDecision,
  EmergencyStopResult,
  ImplementationDispositionDecision,
  ImplementationRecoveryState,
  ImplementationWorkerStatus,
  IntegratedTicketRef,
  LocalUnfinishedWorkflow,
  NextAction,
  NextActionsDiagnostic,
  ParallelDeliveryPanelState,
  PipelineAffectedAttempt,
  PipelinePauseResult,
  PipelineResumeResult,
  PreflightCheck,
  PreflightResult,
  PreflightScope,
  ReadyTicket,
  RepositorySchedulerLease,
  ResolvedWorkerProfile,
  RunTerminationMode,
  RunTerminationResult,
  SpecDraft,
  WorkflowMergeMethod,
  StageConfirmationDecision,
  StageResult,
  TargetBranchLease,
  TicketDraft,
  TicketProgressSummary,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowCoordinator,
  WorkflowCoordinatorLease,
  WorkflowHomeBinding,
  WorkflowHomeLock,
  WorkflowManifest,
  WorkflowPanelState,
  WorkflowRoot,
  WorkflowRootKind,
  WorkflowStage,
  WorkerSlotLease,
} from "./types.js";

type PendingCreateSpec = {
  stage: "create-spec";
  draft: SpecDraft;
};

type PendingCreateTickets = {
  stage: "create-tickets";
  draft: TicketsDraft;
  workflowId: number;
  workflowTitle?: string;
};

type PendingStage = PendingCreateSpec | PendingCreateTickets;

type WorkflowHomeRoute =
  | { kind: "legacy"; active?: ActiveWorkflow }
  | {
      kind: "bound";
      active: ActiveWorkflow;
      target: CanonicalTargetIdentity;
    }
  | {
      kind: "selection-required";
      target: CanonicalTargetIdentity;
      candidates: readonly ActiveWorkflow[];
      staleBinding?: WorkflowHomeBinding;
    }
  | {
      kind: "lease-held";
      target: CanonicalTargetIdentity;
      active: ActiveWorkflow;
      holderId?: string;
    }
  | { kind: "unavailable"; reason: string };

type HeldWorkflowCoordinatorLease = {
  target: CanonicalTargetIdentity;
  workflowId: number;
  lease: WorkflowCoordinatorLease;
  renewedAtMs: number;
};

/** One live Implementation worker's fenced repository-wide capacity lease. */
type HeldWorkerSlot = {
  workerId: string;
  workflowId: number;
  ticketNumber: number;
  lease: WorkerSlotLease;
  renewedAtMs: number;
};

/** Optional in-memory Target-branch lease held while this home drives delivery. */
type HeldTargetBranchLease = {
  target: CanonicalTargetIdentity;
  lease: TargetBranchLease;
  phase?: "refresh" | "validation" | "pr-update" | "merge";
};

type RepositoryWorkerSlotPreview =
  | {
      ok: true;
      capacity: number;
      plan: RepositoryWorkerSlotPlan;
    }
  | { ok: false; reason: string };

type RepositoryWorkerSlotAcquire =
  | {
      ok: true;
      lease: WorkerSlotLease;
      capacity: number;
    }
  | { ok: false; reason: string };

type WorkflowCoordinatorLeaseCheck =
  | { ok: true; lease: WorkflowCoordinatorLease }
  | { ok: false; reason: string; holderId?: string };

type CoordinationRoutingContext =
  | { supported: false }
  | { supported: true; ok: true; target: CanonicalTargetIdentity }
  | { supported: true; ok: false; reason: string };

/**
 * Settled facts for one Implementation attempt transcript.
 * Used by disposition recovery and by startImplementation attempt selection
 * (reuse latest unintegrated attempt vs blind rN+1).
 */
type ImplementationAttemptHistory = {
  implementCompleted: boolean;
  disposition?: ImplementationDispositionDecision;
  integrationFailedReason?: string;
  /** Restored from integration-unit-conflict / conflict-resolution-launch. */
  integrationConflict?: {
    integrationBranch: string;
    integrationWorktreePath: string;
    message: string;
  };
  integrationComplete: boolean;
  summary?: string;
  headSha?: string;
};

/**
 * Reduce retained Worker transcript events for one attempt into completion /
 * disposition / integration facts. Pause/terminate markers do not clear a
 * completed Stage result; worker-aborted and compatibility-recovery do.
 */
function analyzeImplementationAttemptEvents(
  events: readonly unknown[],
): ImplementationAttemptHistory {
  let implementCompleted = false;
  let disposition: ImplementationDispositionDecision | undefined;
  let integrationFailedReason: string | undefined;
  let integrationConflict:
    | {
        integrationBranch: string;
        integrationWorktreePath: string;
        message: string;
      }
    | undefined;
  let integrationComplete = false;
  let summary: string | undefined;
  let headSha: string | undefined;

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const type = e.type;

    if (type === "compatibility-recovery" || type === "worker-aborted") {
      implementCompleted = false;
      disposition = undefined;
      integrationFailedReason = undefined;
      integrationConflict = undefined;
      summary = undefined;
      headSha = undefined;
      continue;
    }

    // pipeline:pause / pipeline:terminate are stop markers only — they must not
    // erase a completed Stage result already on the attempt.

    if (type === "stage-result") {
      const outcome = e.outcome as Record<string, unknown> | undefined;
      if (outcome?.status === "completed") {
        implementCompleted = true;
        disposition = undefined;
        integrationFailedReason = undefined;
        integrationComplete = false;
        if (typeof outcome.summary === "string") summary = outcome.summary;
        if (typeof outcome.localCommitSha === "string") {
          headSha = outcome.localCommitSha;
        }
      } else {
        implementCompleted = false;
        disposition = undefined;
        integrationFailedReason = undefined;
        summary = undefined;
        headSha = undefined;
      }
      continue;
    }

    if (type === "stage-result-inferred") {
      implementCompleted = true;
      disposition = undefined;
      integrationFailedReason = undefined;
      integrationComplete = false;
      if (typeof e.headSha === "string") headSha = e.headSha;
      summary =
        typeof e.reason === "string"
          ? e.reason
          : "Inferred completion from local commits";
      continue;
    }

    if (type === "disposition") {
      const decision = e.decision;
      if (
        decision === "close" ||
        decision === "leave-open" ||
        decision === "investigate"
      ) {
        disposition = decision;
      }
      if (decision === "close" && implementCompleted) {
        integrationFailedReason = undefined;
      } else if (decision === "leave-open" || decision === "investigate") {
        // Settled without integrate; a later implement opens a fresh attempt.
      } else {
        implementCompleted = false;
        disposition = undefined;
        integrationFailedReason = undefined;
        summary = undefined;
        headSha = undefined;
      }
      continue;
    }

    if (type === "integration-unit-failed") {
      if (disposition === "close" || implementCompleted) {
        disposition = "close";
        integrationFailedReason =
          typeof e.reason === "string"
            ? e.reason
            : "Integration unit failed";
      }
      continue;
    }

    // Merge conflict path: ticket still needs Integration (Retry / conflict worker).
    if (type === "integration-unit-conflict") {
      disposition = "close";
      implementCompleted = true;
      integrationComplete = false;
      integrationFailedReason =
        typeof e.reason === "string"
          ? e.reason
          : "Integration unit conflict";
      continue;
    }

    if (type === "conflict-resolution-launch") {
      disposition = "close";
      implementCompleted = true;
      integrationComplete = false;
      const branch =
        typeof e.integrationBranch === "string"
          ? e.integrationBranch
          : undefined;
      const worktree =
        typeof e.integrationWorktreePath === "string"
          ? e.integrationWorktreePath
          : undefined;
      const message =
        typeof e.message === "string"
          ? e.message
          : (integrationFailedReason ?? "Merge conflict");
      if (branch && worktree) {
        integrationConflict = {
          integrationBranch: branch,
          integrationWorktreePath: worktree,
          message,
        };
      }
      if (!integrationFailedReason) {
        integrationFailedReason = message;
      }
      continue;
    }

    if (type === "conflict-resolution-failed") {
      disposition = "close";
      implementCompleted = true;
      integrationComplete = false;
      integrationFailedReason =
        typeof e.reason === "string"
          ? e.reason
          : "Conflict resolution failed";
      continue;
    }

    if (
      type === "integration-unit-completed" ||
      type === "integration-unit-complete" ||
      type === "integration-unit-skipped"
    ) {
      implementCompleted = false;
      disposition = undefined;
      integrationFailedReason = undefined;
      integrationConflict = undefined;
      integrationComplete = true;
      summary = undefined;
      headSha = undefined;
    }
  }

  return {
    implementCompleted,
    integrationComplete,
    ...(disposition !== undefined ? { disposition } : {}),
    ...(integrationFailedReason !== undefined
      ? { integrationFailedReason }
      : {}),
    ...(integrationConflict !== undefined ? { integrationConflict } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(headSha !== undefined ? { headSha } : {}),
  };
}

type ActiveImplementationWorker = {
  workerId: string;
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  status: ImplementationWorkerStatus;
  /**
   * Exact model profile used for this launched attempt.
   * Absent only for transcript-recovered attempts created before this metadata.
   */
  workerProfile?: WorkerProfile;
  /** Pi agent turns observed for this active worker process. */
  turnCount?: number;
  /** Epoch ms of Pi's most recent turn_start event. */
  lastTurnStartedAtMs?: number;
  progress?: string;
  summary?: string;
  /** OS pid of the `pi --mode json` child when known. */
  pid?: number;
  /** Epoch ms when this attempt was launched (R1 runtime base). */
  startedAtMs: number;
  /** True once a stage-result event was handled for this worker. */
  receivedStageResult: boolean;
  /**
   * True once WorkersPort reported this attempt's OS child as alive.
   * Used so panel reconcile does not treat the launch window (runtime not
   * registered yet) as process-gone.
   */
  processObservedAlive?: boolean;
  /** Last provider/model error observed on the worker stream, when any. */
  lastError?: string;
};

/**
 * Session-owned Conflict resolution worker for an in-progress Integration merge.
 * Runs the installed resolving-merge-conflicts skill in the Integration workspace.
 * Supports ticket-to-Integration conflicts and Target-branch refresh conflicts.
 */
type ActiveConflictWorker = {
  workerId: string;
  workflowId: number;
  /**
   * Ticket number for ticket-to-Integration conflicts.
   * Target-refresh uses TARGET_REFRESH_TRANSCRIPT_TICKET (0).
   */
  ticketNumber: number;
  attempt: number;
  /** Discriminates ticket-to-Integration vs Target-refresh conflict ownership. */
  resolutionKind: "ticket-integration" | "target-refresh";
  integrationBranch: string;
  integrationWorktreePath: string;
  /** Target-refresh context when resolutionKind is target-refresh. */
  targetBranch?: string;
  targetSha?: string;
  targetLeaseGeneration?: number;
  status: ImplementationWorkerStatus;
  /** Exact model profile used for this launched conflict-resolution attempt. */
  workerProfile?: WorkerProfile;
  /** Pi agent turns observed for this active conflict worker process. */
  turnCount?: number;
  /** Epoch ms of Pi's most recent turn_start event. */
  lastTurnStartedAtMs?: number;
  progress?: string;
  /** OS pid of the conflict-resolution child when known. */
  pid?: number;
  /** Epoch ms when this conflict worker was launched (R1 runtime base). */
  startedAtMs: number;
  receivedStageResult: boolean;
  /** True once the conflict worker OS child was observed alive. */
  processObservedAlive?: boolean;
};

/**
 * In-flight Target-branch refresh of the Integration branch.
 * Holds facts needed to resume Conflict resolution or finalize after a clean merge.
 */
type PendingTargetRefresh = {
  workflowId: number;
  attempt: number;
  targetBranch: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  targetSha?: string;
  targetLeaseGeneration?: number;
  lastFailure?: string;
  conflict?: TargetRefreshConflict;
};

/**
 * One completed ticket waiting for (or retrying) a serialized Integration unit.
 * Only one Integration unit runs at a time; tickets do not close yet.
 */
type PendingIntegration = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  lastFailure?: string;
  /**
   * Set when a merge conflict left an in-progress merge for Conflict resolution.
   * While present, retries re-launch the Conflict resolution worker instead of re-merging.
   */
  conflict?: {
    integrationBranch: string;
    integrationWorktreePath: string;
    message: string;
  };
};

type PendingCiRecovery = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  integrationBranch: string;
  url?: string;
  summary?: string;
};


/**
 * Create the Workflow coordinator — the sole product seam for Matt Auto.
 *
 * Product rules (root selection, preflight, Worker profile precedence, Next
 * actions, later stages) live here. Adapters are injected as ports and are not
 * part of this interface.
 */
let coordinatorLogger: MattAutoLogger | undefined;

/** Attach the Workflow-root Matt Auto logger for coordinator diagnostics. */
export function setCoordinatorLogger(
  logger: MattAutoLogger | undefined,
): void {
  coordinatorLogger = logger;
}

function clog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown,
): void {
  coordinatorLogger?.[level](message, data);
}

export function createWorkflowCoordinator(
  ports: WorkflowCoordinatorPorts,
): WorkflowCoordinator {
  let selectedPath: string | undefined;
  let scoped: RootScopedPorts | undefined;
  /** Stable identity for this live Workflow home process/session. */
  const workflowHomeHolderId = `workflow-home-${process.pid}-${randomUUID()}`;
  /** Locally acquired checkout guard (when the root supplies one). */
  let heldWorkflowHomeLock: WorkflowHomeLock | undefined;
  let lastWorkflowHomeLockHeartbeatAtMs = 0;
  /** Remote fenced lease for the one coordination-aware Workflow this home owns. */
  let heldWorkflowCoordinatorLease: HeldWorkflowCoordinatorLease | undefined;
  let workflowCoordinatorHeartbeatTimer: NodeJS.Timeout | undefined;
  let workflowCoordinatorHeartbeatUsers = 0;
  let workflowCoordinatorHeartbeatInFlight = false;
  /** Serialize conditional lease maintenance from UI, workers, and heartbeats. */
  let workflowCoordinatorLeaseMutex: Promise<void> = Promise.resolve();
  /**
   * Repository-wide worker-slot leases owned by this Workflow home, keyed by
   * the live Implementation worker they authorize. A slot is never used by
   * Planning, Integration, or Conflict resolution workers.
   */
  const heldWorkerSlots = new Map<string, HeldWorkerSlot>();
  let workerSlotHeartbeatTimer: NodeJS.Timeout | undefined;
  let workerSlotHeartbeatInFlight = false;
  /** Serialize slot loss/release/heartbeat so stale callbacks cannot revive ownership. */
  let workerSlotLeaseMutex: Promise<void> = Promise.resolve();
  /** Session-local pending Stage confirmation (never remote until Publish). */
  let pending: PendingStage | undefined;
  /**
   * Session-owned Implementation workers keyed by workerId.
   * Holds running workers and completed workers waiting to become
   * pendingDisposition (at most one pendingDisposition at a time).
   * Lifetime is bound to Workflow home; never durable across processes.
   * Conflict resolution remains singular and separate.
   */
  const activeImplementationWorkers = new Map<
    string,
    ActiveImplementationWorker
  >();
  /**
   * Worker ids currently settling a process-exit (real or reconciled).
   * Prevents concurrent panel polls from re-entering settlement and spamming
   * stage-result-inferred / compatibility-recovery events.
   */
  const processExitHandling = new Set<string>();
  /**
   * Worker ids for which we already synthesized a process-gone event this session.
   * Permanent for the attempt so live panel polls never re-append process-gone.
   */
  const processGoneSynthesized = new Set<string>();
  /**
   * The single Implementation disposition currently offered as a Next action.
   * Additional completed workers stay in activeImplementationWorkers until
   * this slot frees and they can be promoted (Stage results are never dropped).
   */
  let pendingDisposition: ActiveImplementationWorker | undefined;
  /**
   * Pending Integration unit after Close disposition (or a fail-closed retry).
   * Serialized: at most one ticket at a time.
   */
  let pendingIntegration: PendingIntegration | undefined;
  /** Guard against re-entrant Integration unit execution. */
  let integrationInProgress = false;
  /** Epoch ms when the current Integration unit (or Target-refresh) entered running. */
  let integrationUnitStartedAtMs: number | undefined;
  /** True while Create-tickets publish loop is creating issues / writing manifest. */
  let createTicketsPublishInProgress = false;
  /**
   * Session-owned Conflict resolution worker for a preserved in-progress merge.
   * Lifetime is bound to Workflow home; never durable across processes.
   * Handles both ticket-to-Integration and Target-refresh conflicts.
   */
  let activeConflictWorker: ActiveConflictWorker | undefined;
  /**
   * In-flight Target-branch refresh (merge Target into Integration under the
   * Target-branch lease). Serialized with Integration units and conflict workers.
   */
  let pendingTargetRefresh: PendingTargetRefresh | undefined;
  let targetRefreshInProgress = false;
  /**
   * Queue orchestrator that holds the Target-branch lease for the active refresh.
   * Kept alive across Conflict resolution so finalize / fail can release the lane.
   */
  let targetDeliveryQueue: TargetBranchQueueOrchestrator | undefined;
  let pendingCiRecovery: PendingCiRecovery | undefined;
  /**
   * Session pointer to the most recently cleaned-up workflow on this Target branch.
   * Enables Start Follow-up without mutating the completed workflow.
   */
  /** Last nextActions() routing diagnostic for pipeline idle logging. */
  let lastNextActionsDiagnostic: NextActionsDiagnostic | undefined;

  let lastCompletedWorkflow:
    | { workflowId: number; title?: string; targetBranch: string }
    | undefined;
  /** Ticket numbers that recently hit implementation recovery — skip auto re-launch. */
  const implementationRecoveryCooldown = new Map<
    number,
    { sinceMs: number; reason?: string }
  >();
  const IMPLEMENTATION_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

  function rememberImplementationRecovery(
    ticketNumber: number,
    reason?: string,
  ): void {
    implementationRecoveryCooldown.set(ticketNumber, {
      sinceMs: Date.now(),
      ...(reason ? { reason } : {}),
    });
  }

  function getImplementationRecoveryStates(): readonly ImplementationRecoveryState[] {
    const now = Date.now();
    const states: ImplementationRecoveryState[] = [];
    for (const [ticketNumber, entry] of implementationRecoveryCooldown) {
      const untilMs = entry.sinceMs + IMPLEMENTATION_RECOVERY_COOLDOWN_MS;
      const remainingMs = untilMs - now;
      if (remainingMs <= 0) {
        implementationRecoveryCooldown.delete(ticketNumber);
        continue;
      }
      states.push({
        ticketNumber,
        sinceMs: entry.sinceMs,
        untilMs,
        remainingMs,
        ...(entry.reason ? { reason: entry.reason } : {}),
      });
    }
    return states.sort((a, b) => a.ticketNumber - b.ticketNumber);
  }
  /**
   * Session-owned Pipeline pause flag. When true, auto-advance / preferred Next
   * must not continue the run loop. Cleared only by Resume or beginPipelineRun.
   */
  let pipelinePaused = false;
  /** When set, worker runtime (R1) freezes at this epoch ms while paused. */
  let pipelinePausedAtMs: number | undefined;
  /** Epoch ms when the current /matt-auto run began (dashboard total elapsed). */
  let pipelineRunStartedAtMs: number | undefined;
  /** Session-owned Run termination flag until the next explicit pipeline run. */
  let runTerminated = false;
  /** Last operator stop that affected the run loop (panel / brief surface). */
  let lastStopReason:
    | "pipeline-pause"
    | "run-termination"
    | "emergency-stop"
    | undefined;
  /** T1/T2 mode recorded when lastStopReason is run-termination. */
  let lastTerminationMode: RunTerminationMode | undefined;
  /**
   * Target-branch lease held by this home while driving serial delivery.
   * Pause/Terminate also release a remotely observed lease when holderId matches.
   */
  let heldTargetBranchLease: HeldTargetBranchLease | undefined;
  /** Cached parallel-delivery snapshot for local panel polls. */
  let cachedParallelDelivery:
    | { workflowId: number; state: ParallelDeliveryPanelState }
    | undefined;
  /** True after a heartbeat/verification loses the Workflow coordinator lease. */
  let coordinatorLeaseLost = false;
  /**
   * Successful worker facts outlive the live-worker panel within this session.
   * They are keyed by attempt/kind so retries and conflict workers stay distinct.
   */
  const completedWorkerTelemetryByAttempt = new Map<
    string,
    CompletedWorkerTelemetry
  >();
  /** Transcript attempts already hydrated into the session-local telemetry cache. */
  const recoveredCompletedWorkerTranscriptKeys = new Set<string>();

  function completedWorkerTelemetryKey(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    kind: CompletedWorkerTelemetry["kind"];
  }): string {
    return `${input.workflowId}:${input.ticketNumber}:${input.attempt}:${input.kind}`;
  }

  function transcriptAttemptKey(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }): string {
    return `${input.workflowId}:${input.ticketNumber}:${input.attempt}`;
  }

  function rememberCompletedWorkerTelemetry(
    telemetry: CompletedWorkerTelemetry,
  ): boolean {
    const key = completedWorkerTelemetryKey(telemetry);
    if (completedWorkerTelemetryByAttempt.has(key)) return false;
    completedWorkerTelemetryByAttempt.set(key, telemetry);
    return true;
  }

  function recordCompletedWorkerTelemetry(
    worker: {
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      startedAtMs: number;
      turnCount?: number;
    },
    kind: CompletedWorkerTelemetry["kind"],
  ): CompletedWorkerTelemetry | undefined {
    // Historical/recovered workers have no observed turn count; never invent one.
    if (typeof worker.turnCount !== "number") return undefined;
    const completedAtMs = Date.now();
    const telemetry: CompletedWorkerTelemetry = {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
      kind,
      turnCount: worker.turnCount,
      startedAtMs: worker.startedAtMs,
      completedAtMs,
      runtimeMs: Math.max(0, completedAtMs - worker.startedAtMs),
    };
    return rememberCompletedWorkerTelemetry(telemetry) ? telemetry : undefined;
  }

  async function persistCompletedWorkerTelemetry(
    bound: RootScopedPorts,
    transcriptKey: {
      workflowId: number;
      ticketNumber: number;
      attempt: number;
    },
    workerId: string,
    telemetry: CompletedWorkerTelemetry | undefined,
  ): Promise<void> {
    if (!telemetry) return;
    if (
      typeof telemetry.startedAtMs !== "number" ||
      typeof telemetry.completedAtMs !== "number" ||
      typeof telemetry.runtimeMs !== "number"
    ) {
      return;
    }
    await bound.transcripts.append(transcriptKey, {
      type: "worker-telemetry-completed",
      workerId,
      ...telemetry,
    });
  }

  function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function telemetryFromTranscriptEvent(
    raw: unknown,
    expected: {
      workflowId: number;
      ticketNumber: number;
      attempt: number;
    },
  ): CompletedWorkerTelemetry | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const event = raw as Record<string, unknown>;
    if (event.type !== "worker-telemetry-completed") return undefined;
    if (
      event.workflowId !== expected.workflowId ||
      event.ticketNumber !== expected.ticketNumber ||
      event.attempt !== expected.attempt ||
      (event.kind !== "implementation" && event.kind !== "conflict-resolution") ||
      !Number.isInteger(event.turnCount) ||
      !isNonNegativeFiniteNumber(event.turnCount) ||
      !isNonNegativeFiniteNumber(event.startedAtMs) ||
      !isNonNegativeFiniteNumber(event.completedAtMs) ||
      !isNonNegativeFiniteNumber(event.runtimeMs)
    ) {
      return undefined;
    }
    if (
      Math.max(0, event.completedAtMs - event.startedAtMs) !== event.runtimeMs
    ) {
      return undefined;
    }
    return {
      workflowId: expected.workflowId,
      ticketNumber: expected.ticketNumber,
      attempt: expected.attempt,
      kind: event.kind,
      turnCount: event.turnCount,
      startedAtMs: event.startedAtMs,
      completedAtMs: event.completedAtMs,
      runtimeMs: event.runtimeMs,
    };
  }

  function legacyImplementationTurnTelemetry(
    events: readonly unknown[],
    key: { workflowId: number; ticketNumber: number; attempt: number },
  ): CompletedWorkerTelemetry | undefined {
    const history = analyzeImplementationAttemptEvents(events);
    if (!history.implementCompleted && !history.integrationComplete) {
      return undefined;
    }

    const launchEvents = events.filter((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const event = raw as Record<string, unknown>;
      return event.type === "worker-launch" && typeof event.workerId === "string";
    }) as Array<Record<string, unknown>>;
    // Multiple launch records make historical per-process attribution ambiguous.
    if (launchEvents.length !== 1) return undefined;
    const workerId = launchEvents[0]!.workerId as string;
    const turnCount = events.filter((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const event = raw as Record<string, unknown>;
      return (
        event.type === "turn-start" &&
        event.workerId === workerId &&
        isNonNegativeFiniteNumber(event.timestampMs)
      );
    }).length;

    // Legacy transcripts lack exact launch/completion timestamps: preserve only
    // the directly observed turn count and leave runtime absent rather than infer it.
    return {
      ...key,
      kind: "implementation",
      turnCount,
    };
  }

  async function recoverCompletedWorkerTelemetryFromTranscripts(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<void> {
    const ticketNumbers = new Set<number>([
      ...(active.tickets ?? []),
      ...(active.integratedTickets ?? []).map((ticket) => ticket.number),
    ]);

    for (const ticketNumber of ticketNumbers) {
      let latestAttempt: number;
      try {
        latestAttempt = await bound.workspace.latestAttempt(
          active.workflowId,
          ticketNumber,
        );
      } catch {
        // Telemetry recovery must not block a workflow when local Git inspection fails.
        continue;
      }
      for (let attempt = 1; attempt <= latestAttempt; attempt += 1) {
        const key = {
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
        };
        const transcriptKey = transcriptAttemptKey(key);
        if (recoveredCompletedWorkerTranscriptKeys.has(transcriptKey)) continue;
        let events: readonly unknown[];
        try {
          events = await bound.transcripts.read(key);
        } catch {
          // A missing/corrupt local transcript is diagnostic-only, never a gate.
          continue;
        }
        recoveredCompletedWorkerTranscriptKeys.add(transcriptKey);

        let hasPersistedImplementationTelemetry = false;
        for (const event of events) {
          const telemetry = telemetryFromTranscriptEvent(event, key);
          if (!telemetry) continue;
          if (telemetry.kind === "implementation") {
            hasPersistedImplementationTelemetry = true;
          }
          rememberCompletedWorkerTelemetry(telemetry);
        }
        if (!hasPersistedImplementationTelemetry) {
          const legacy = legacyImplementationTurnTelemetry(events, key);
          if (legacy) rememberCompletedWorkerTelemetry(legacy);
        }
      }
    }
  }

  function getCompletedWorkerTelemetry(
    workflowId: number,
  ): readonly CompletedWorkerTelemetry[] {
    return [...completedWorkerTelemetryByAttempt.values()]
      .filter((telemetry) => telemetry.workflowId === workflowId)
      .sort((a, b) =>
        a.ticketNumber - b.ticketNumber ||
        a.attempt - b.attempt ||
        a.kind.localeCompare(b.kind),
      )
      .map((telemetry) => ({ ...telemetry }));
  }

  function getPipelineRunElapsedMs(): number | undefined {
    return typeof pipelineRunStartedAtMs === "number"
      ? Math.max(0, Date.now() - pipelineRunStartedAtMs)
      : undefined;
  }

  function findImplementationWorker(
    workerId: string,
  ): ActiveImplementationWorker | undefined {
    return (
      activeImplementationWorkers.get(workerId) ??
      (pendingDisposition?.workerId === workerId
        ? pendingDisposition
        : undefined)
    );
  }

  function hasRunningImplementationWorkers(): boolean {
    return countRunningImplementationWorkers([
      ...activeImplementationWorkers.values(),
    ]) > 0;
  }

  function runningImplementationCount(): number {
    return countRunningImplementationWorkers([
      ...activeImplementationWorkers.values(),
    ]);
  }

  /**
   * Free Implementation slots: max(0, N - running).
   * N is effective Worker concurrency (root → global → default 2).
   */
  async function localWorkerCapacitySeed(
    bound: RootScopedPorts,
  ): Promise<number> {
    const root = await bound.preferences.getRootWorkerConcurrency();
    const global = await bound.preferences.getGlobalWorkerConcurrency();
    return resolveEffectiveWorkerConcurrency(root, global);
  }

  async function freeImplementationSlots(
    bound: RootScopedPorts,
  ): Promise<{ n: number; running: number; slots: number }> {
    const n = await localWorkerCapacitySeed(bound);
    const running = runningImplementationCount();
    return { n, running, slots: computeImplementationSlots(n, running) };
  }

  /**
   * True when any completed worker is waiting to become pendingDisposition
   * (P1: process disposition before opening more implements).
   */
  function hasNeedsDispositionWaiting(): boolean {
    if (pendingDisposition) return true;
    for (const worker of activeImplementationWorkers.values()) {
      if (worker.status === "needs-disposition") return true;
    }
    return false;
  }

  function findRunningWorkerForTicket(
    ticketNumber: number,
  ): ActiveImplementationWorker | undefined {
    for (const worker of activeImplementationWorkers.values()) {
      if (
        worker.ticketNumber === ticketNumber &&
        worker.status === "running"
      ) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Shared P1 + slot gate for new Implementation launches (including Rework).
   * Returns a failed StageResult when blocked; undefined when allowed.
   */
  async function blockNewImplementationLaunch(
    bound: RootScopedPorts,
    ticketNumber: number,
    stage: "implement" | "rework" = "implement",
    active?: ActiveWorkflow,
  ): Promise<StageResult | undefined> {
    // Coordination-aware workflows use remote worker-slot leases instead of
    // this checkout's local N/running accounting. Keep only the workflow-local
    // P1 gates here; actual repository capacity is acquired immediately before
    // a worker process starts.
    const localSlots = active?.coordination
      ? { n: 0, running: runningImplementationCount(), slots: 1 }
      : await freeImplementationSlots(bound);
    const { n, running, slots } = localSlots;
    const reason = implementationLaunchBlockReason({
      slots,
      pendingDisposition: hasNeedsDispositionWaiting(),
      // Target-branch refresh is serialized like an Integration unit: no new
      // Implementation workers while the serial Target delivery lane is active.
      pendingIntegration:
        pendingIntegration !== undefined || pendingTargetRefresh !== undefined,
      activeConflictWorker: activeConflictWorker !== undefined,
      // Specific ticket readiness is checked separately; treat as non-empty here.
      readyCount: 1,
    });
    if (!reason) return undefined;

    if (reason === "pending-disposition") {
      const waiting =
        pendingDisposition ??
        [...activeImplementationWorkers.values()].find(
          (w) => w.status === "needs-disposition",
        );
      return {
        status: "failed",
        stage,
        reason: waiting
          ? `An Implementation disposition is pending for #${waiting.ticketNumber}. Choose Close, Leave open, or Investigate before launching another worker.`
          : "An Implementation disposition is pending. Resolve it before launching another worker.",
        ticketNumber,
      };
    }
    if (reason === "pending-integration") {
      return {
        status: "failed",
        stage,
        reason: `An Integration unit is pending for #${pendingIntegration!.ticketNumber}. Finish Integration before launching another Implementation worker.`,
        ticketNumber,
      };
    }
    if (reason === "conflict-worker") {
      return {
        status: "failed",
        stage,
        reason: `A Conflict resolution worker is active for #${activeConflictWorker!.ticketNumber}. Finish conflict resolution before launching another Implementation worker.`,
        ticketNumber,
      };
    }
    // no-slots (empty-frontier is handled by ready-ticket checks)
    return {
      status: "failed",
      stage,
      reason: `No free Implementation worker slots (running ${running} of effective concurrency ${n}). Wait for a worker to finish before launching another.`,
      ticketNumber,
    };
  }

  async function withWorkerSlotLeaseMutex<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = workerSlotLeaseMutex;
    let unlock: (() => void) | undefined;
    workerSlotLeaseMutex = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock?.();
    }
  }

  function sameCanonicalRepository(
    left: CanonicalRepositoryIdentity,
    right: CanonicalRepositoryIdentity,
  ): boolean {
    return canonicalRepositoryIdentityKey(left) === canonicalRepositoryIdentityKey(right);
  }

  /**
   * Read the ready queues that are eligible for repository-wide scheduling.
   * The optional repository query is used when available so a second Target
   * branch cannot silently evade the repository capacity policy. Older
   * TrackerPorts retain a safe exact-Target fallback while they migrate.
   */
  async function repositoryWorkerDemands(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<RepositoryWorkerDemand[]> {
    const target = active.coordination?.target;
    if (!target) return [];

    const discovered = bound.tracker.findActiveWorkflowsForRepository
      ? await bound.tracker.findActiveWorkflowsForRepository(target.repository)
      : await bound.tracker.findActiveWorkflows(target);
    const byWorkflowId = new Map<number, ActiveWorkflow>();
    for (const candidate of discovered) {
      if (
        !candidate.coordination ||
        !sameCanonicalRepository(
          candidate.coordination.target.repository,
          target.repository,
        )
      ) {
        continue;
      }
      byWorkflowId.set(candidate.workflowId, candidate);
    }
    // Tracker snapshots can briefly lag a freshly written manifest. The bound
    // workflow's current observed facts must still participate in its own plan.
    byWorkflowId.set(active.workflowId, active);

    const workflows = [...byWorkflowId.values()]
      .filter(
        (candidate) =>
          Boolean(candidate.coordination) &&
          isTicketWorkStage(candidate.stage) &&
          (candidate.tickets?.length ?? 0) > 0,
      )
      .sort((left, right) => left.workflowId - right.workflowId);

    return Promise.all(
      workflows.map(async (workflow): Promise<RepositoryWorkerDemand> => {
        const tickets = await bound.tracker.listTickets(workflow.tickets ?? []);
        const integrated = new Set(
          (workflow.integratedTickets ?? []).map((ticket) => ticket.number),
        );
        const progress = computeTicketProgress(
          workflow.workflowId,
          tickets,
          integrated,
        );
        return {
          workflowId: workflow.workflowId,
          readyTicketNumbers: progress.ready.map((ticket) => ticket.number),
        };
      }),
    );
  }

  async function repositoryWorkerSlotPlan(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
    capacity: number,
  ): Promise<RepositoryWorkerSlotPlan> {
    const coordination = bound.coordination;
    const target = active.coordination?.target;
    if (!coordination || !target) {
      throw new Error("Repository worker scheduling requires coordination-aware workflow facts.");
    }

    // Demand is read before leases so the latter is the closest practical
    // snapshot to conditional allocation while the scheduler lease is held.
    const demands = await repositoryWorkerDemands(bound, active);
    const leases = await coordination.listLeases({
      repository: target.repository,
      kind: "worker-slot",
    });
    // Ask the CoordinationPort to apply its authoritative clock/fence check
    // rather than inferring liveness from this process's wall clock. That keeps
    // deterministic ports and separate machines consistent at lease expiry.
    const verifiedSlots = await Promise.all(
      leases
        .filter(
          (lease): lease is WorkerSlotLease =>
            lease.kind === "worker-slot" && lease.releasedAt === undefined,
        )
        .map(async (lease) => {
          const verified = await coordination.verifyLease(lease);
          return verified.valid && verified.lease.kind === "worker-slot"
            ? verified.lease
            : undefined;
        }),
    );
    const occupied: OccupiedRepositoryWorkerSlot[] = verifiedSlots
      .filter((lease): lease is WorkerSlotLease => lease !== undefined)
      .map((lease) => ({
        slot: lease.scope.slot,
        workflowId: lease.workflowId,
        ...(lease.ticketNumber !== undefined
          ? { ticketNumber: lease.ticketNumber }
          : {}),
      }));

    return planRepositoryWorkerSlots({ capacity, occupied, demands });
  }

  /** Read-only advisory used by Next actions; conditional acquisition remains authoritative. */
  async function previewRepositoryWorkerSlots(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<RepositoryWorkerSlotPreview> {
    const coordination = bound.coordination;
    const target = active.coordination?.target;
    if (!coordination || !target) {
      return {
        ok: false,
        reason: "Repository worker scheduling is unavailable for this coordination-aware workflow.",
      };
    }
    try {
      const policy = await coordination.getWorkerCapacityPolicy(target.repository);
      const capacity = policy?.workerCapacity ?? (await localWorkerCapacitySeed(bound));
      return {
        ok: true,
        capacity,
        plan: await repositoryWorkerSlotPlan(bound, active, capacity),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not inspect repository-wide Implementation capacity: ${message}`,
      };
    }
  }

  function repositorySlotWaitReason(
    plan: RepositoryWorkerSlotPlan,
    workflowId: number,
    ticketNumber: number,
  ): string {
    if (plan.freeSlots.length === 0) {
      return `Repository-wide Implementation capacity is full (${plan.occupied.length} live worker-slot lease(s) for capacity ${plan.capacity}). Wait for a worker to finish or an expired lease to be reclaimed.`;
    }
    const sameWorkflow = plan.claimable.find(
      (claim) => claim.workflowId === workflowId,
    );
    if (sameWorkflow) {
      return `Repository scheduler allocates tickets in ready order: #${sameWorkflow.ticketNumber} receives Workflow #${workflowId}'s next fair slot before #${ticketNumber}.`;
    }
    const next = plan.claimable[0];
    if (next) {
      return `Repository scheduler gives Workflow #${next.workflowId} its first fair slot for #${next.ticketNumber} before Workflow #${workflowId} receives another slot.`;
    }
    return `No repository-wide Implementation worker slot is currently allocatable for #${ticketNumber}.`;
  }

  async function acquireRepositorySchedulerLease(
    bound: RootScopedPorts,
    repository: CanonicalRepositoryIdentity,
  ): Promise<
    | { acquired: true; lease: RepositorySchedulerLease }
    | { acquired: false; holderId?: string }
  > {
    const coordination = bound.coordination;
    if (!coordination) return { acquired: false };

    // Separate homes commonly enter /matt-auto run together. Wait briefly for
    // a compliant scheduler holder to finish its tiny snapshot/assignment
    // critical section rather than treating an ordinary race as a pipeline
    // failure. TTL recovery remains the safe path for a crashed holder.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await coordination.acquireLease({
        kind: "repository-scheduler",
        repository,
        holderId: workflowHomeHolderId,
        ttlMs: DEFAULT_REPOSITORY_SCHEDULER_LEASE_TTL_MS,
      });
      if (result.acquired && result.lease.kind === "repository-scheduler") {
        return { acquired: true, lease: result.lease };
      }
      if (!result.acquired && result.reason !== "held") {
        return { acquired: false, ...(result.lease ? { holderId: result.lease.holderId } : {}) };
      }
      if (attempt < 24) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!result.acquired && attempt === 24) {
        return {
          acquired: false,
          ...(result.lease ? { holderId: result.lease.holderId } : {}),
        };
      }
    }
    return { acquired: false };
  }

  /**
   * Acquire the one remote worker-slot lease that authorizes a new
   * Implementation process. Scheduler ownership is released before the worker
   * launches; the worker retains only its own renewable slot lease.
   */
  async function acquireRepositoryWorkerSlot(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
    ticketNumber: number,
  ): Promise<RepositoryWorkerSlotAcquire> {
    const coordination = bound.coordination;
    const target = active.coordination?.target;
    if (!coordination || !target) {
      return {
        ok: false,
        reason:
          "Repository worker scheduling is unavailable for this coordination-aware workflow.",
      };
    }

    // Never schedule additional work while a previously owned worker may have
    // lost its fence. This check aborts any unowned process before proceeding.
    await heartbeatHeldWorkerSlots(bound, { verify: true });

    let capacity: number;
    try {
      const policy = await coordination.ensureWorkerCapacityPolicy({
        repository: target.repository,
        seedWorkerCapacity: await localWorkerCapacitySeed(bound),
      });
      capacity = policy.policy.workerCapacity;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not load the repository-wide worker-capacity policy: ${message}`,
      };
    }

    let schedulerLease: RepositorySchedulerLease | undefined;
    try {
      const acquired = await acquireRepositorySchedulerLease(
        bound,
        target.repository,
      );
      if (!acquired.acquired) {
        return {
          ok: false,
          reason: `Repository worker scheduler is busy${acquired.holderId ? ` (held by ${acquired.holderId})` : ""}. Wait for its short lease to release, then retry the ready frontier.`,
        };
      }
      schedulerLease = acquired.lease;

      const plan = await repositoryWorkerSlotPlan(bound, active, capacity);
      // Discovery can take longer than the scheduler's short TTL. Renew and
      // fence-check immediately before assigning a slot from this snapshot.
      const renewed = await coordination.renewLease({
        lease: schedulerLease,
        ttlMs: DEFAULT_REPOSITORY_SCHEDULER_LEASE_TTL_MS,
      });
      if (!renewed.renewed || renewed.lease.kind !== "repository-scheduler") {
        return {
          ok: false,
          reason: `Repository worker scheduler lease was lost while computing allocation (${renewed.renewed ? "unexpected lease kind" : renewed.reason}). Retry the ready frontier.`,
        };
      }
      schedulerLease = renewed.lease;

      const claim = plan.claimable.find(
        (candidate) =>
          candidate.workflowId === active.workflowId &&
          candidate.ticketNumber === ticketNumber,
      );
      const slotNumber = plan.freeSlots[0];
      if (!claim || slotNumber === undefined) {
        return {
          ok: false,
          reason: repositorySlotWaitReason(plan, active.workflowId, ticketNumber),
        };
      }

      const slot = await coordination.acquireLease({
        kind: "worker-slot",
        repository: target.repository,
        slot: slotNumber,
        holderId: workflowHomeHolderId,
        workflowId: active.workflowId,
        ticketNumber,
        ttlMs: DEFAULT_COORDINATION_LEASE_TTL_MS,
      });
      if (!slot.acquired || slot.lease.kind !== "worker-slot") {
        return {
          ok: false,
          reason: `Repository worker-slot ${slotNumber} changed while it was being assigned${!slot.acquired && slot.lease?.holderId ? ` (now held by ${slot.lease.holderId})` : ""}. Retry the ready frontier.`,
        };
      }
      return { ok: true, lease: slot.lease, capacity };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not allocate a repository-wide Implementation worker slot: ${message}`,
      };
    } finally {
      if (schedulerLease) {
        try {
          await coordination.releaseLease(schedulerLease);
        } catch {
          // A short TTL provides fail-closed recovery if a release races or the
          // remote becomes unreachable after the worker slot was assigned.
        }
      }
    }
  }

  function stopWorkerSlotHeartbeat(): void {
    if (workerSlotHeartbeatTimer) {
      clearInterval(workerSlotHeartbeatTimer);
      workerSlotHeartbeatTimer = undefined;
    }
  }

  function startWorkerSlotHeartbeat(bound: RootScopedPorts): void {
    if (workerSlotHeartbeatTimer || heldWorkerSlots.size === 0) return;
    workerSlotHeartbeatTimer = setInterval(() => {
      if (workerSlotHeartbeatInFlight || scoped !== bound) return;
      workerSlotHeartbeatInFlight = true;
      void heartbeatHeldWorkerSlots(bound).finally(() => {
        workerSlotHeartbeatInFlight = false;
      });
    }, Math.max(1_000, Math.floor(DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS / 2)));
    workerSlotHeartbeatTimer.unref();
  }

  function holdWorkerSlot(bound: RootScopedPorts, held: HeldWorkerSlot): void {
    heldWorkerSlots.set(held.workerId, held);
    startWorkerSlotHeartbeat(bound);
  }

  async function releaseHeldWorkerSlotUnlocked(
    bound: RootScopedPorts | undefined,
    workerId: string,
  ): Promise<void> {
    const held = heldWorkerSlots.get(workerId);
    if (!held) return;
    heldWorkerSlots.delete(workerId);
    if (heldWorkerSlots.size === 0) stopWorkerSlotHeartbeat();
    if (!bound?.coordination) return;
    try {
      await bound.coordination.releaseLease(held.lease);
    } catch {
      // A worker has already stopped. TTL expiry is sufficient if an explicit
      // release cannot reach the coordination ref.
    }
  }

  async function releaseHeldWorkerSlot(
    bound: RootScopedPorts | undefined,
    workerId: string,
  ): Promise<void> {
    await withWorkerSlotLeaseMutex(() =>
      releaseHeldWorkerSlotUnlocked(bound, workerId),
    );
  }

  /**
   * Release every repository worker-slot lease currently held by this home.
   * Returns how many slots were released (best-effort).
   */
  async function releaseAllHeldWorkerSlots(
    bound: RootScopedPorts | undefined,
  ): Promise<number> {
    return withWorkerSlotLeaseMutex(async () => {
      const workerIds = [...heldWorkerSlots.keys()];
      for (const workerId of workerIds) {
        await releaseHeldWorkerSlotUnlocked(bound, workerId);
      }
      return workerIds.length;
    });
  }

  /**
   * Release the Target-branch lease when this home holds it (in-memory or by
   * matching remote holderId). Never releases a sibling home's lease.
   */
  async function releaseBoundTargetBranchLease(
    bound: RootScopedPorts | undefined,
    target?: CanonicalTargetIdentity,
  ): Promise<boolean> {
    if (!bound?.coordination) {
      heldTargetBranchLease = undefined;
      return false;
    }

    const held = heldTargetBranchLease;
    if (held) {
      heldTargetBranchLease = undefined;
      try {
        const released = await bound.coordination.releaseLease(held.lease);
        return released.released;
      } catch {
        return false;
      }
    }

    if (!target) return false;
    try {
      const observed = await bound.coordination.getLease({
        kind: "target-branch",
        target,
      });
      if (!observed || observed.kind !== "target-branch") return false;
      if (observed.releasedAt) return false;
      if (observed.holderId !== workflowHomeHolderId) return false;
      const released = await bound.coordination.releaseLease(observed);
      return released.released;
    } catch {
      return false;
    }
  }

  async function abandonLostWorkerSlotUnlocked(
    bound: RootScopedPorts,
    held: HeldWorkerSlot,
    reason: string,
  ): Promise<void> {
    // Delete before aborting. A late timer or worker event must never treat a
    // lost fencing token as capacity it can renew or release.
    if (heldWorkerSlots.get(held.workerId) !== held) return;
    heldWorkerSlots.delete(held.workerId);
    if (heldWorkerSlots.size === 0) stopWorkerSlotHeartbeat();

    try {
      await bound.workers.abort(held.workerId);
    } catch {
      // Worker adapters own process termination; do not keep scheduling based
      // on a slot we can no longer prove we own if their best-effort abort fails.
    }

    const worker = activeImplementationWorkers.get(held.workerId);
    if (worker?.status === "running") {
      worker.status = "aborted";
      activeImplementationWorkers.delete(held.workerId);
      rememberImplementationRecovery(
        worker.ticketNumber,
        "Worker aborted after losing its repository worker-slot lease.",
      );
    }
    await bound.transcripts.append(
      {
        workflowId: held.workflowId,
        ticketNumber: held.ticketNumber,
        attempt: worker?.attempt ?? 1,
      },
      {
        type: "worker-slot-lost",
        workerId: held.workerId,
        slot: held.lease.scope.slot,
        generation: held.lease.generation,
        reason,
      },
    );
    invalidatePanelCaches();
  }

  /** Renew live slots, or prove ownership before a new launch when requested. */
  async function heartbeatHeldWorkerSlots(
    bound: RootScopedPorts,
    options: { verify?: boolean } = {},
  ): Promise<void> {
    await withWorkerSlotLeaseMutex(async () => {
      const coordination = bound.coordination;
      for (const held of [...heldWorkerSlots.values()]) {
        if (heldWorkerSlots.get(held.workerId) !== held) continue;
        const worker = activeImplementationWorkers.get(held.workerId);
        if (!worker || worker.status !== "running") {
          await releaseHeldWorkerSlotUnlocked(bound, held.workerId);
          continue;
        }
        const runtime = bound.workers.getRuntime(held.workerId);
        noteRuntimeObservation(worker, runtime);
        // Only free capacity for a process we can prove is gone. Missing runtime
        // during the launch window must not drop the slot (live panel polls race
        // workers.launch registration).
        const processGone =
          (runtime !== undefined && !runtime.alive) ||
          (runtime === undefined && worker.processObservedAlive === true);
        if (processGone) {
          // A dead process cannot retain capacity while the panel/reconciler
          // synthesizes its terminal Worker protocol event.
          await releaseHeldWorkerSlotUnlocked(bound, held.workerId);
          continue;
        }
        if (!coordination) {
          await abandonLostWorkerSlotUnlocked(
            bound,
            held,
            "Remote worker-slot coordination is no longer available.",
          );
          continue;
        }

        const due =
          Date.now() - held.renewedAtMs >=
          DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS;
        try {
          if (due) {
            const renewed = await coordination.renewLease({
              lease: held.lease,
              ttlMs: DEFAULT_COORDINATION_LEASE_TTL_MS,
            });
            if (!renewed.renewed || renewed.lease.kind !== "worker-slot") {
              await abandonLostWorkerSlotUnlocked(
                bound,
                held,
                `Worker-slot lease could not be renewed (${renewed.renewed ? "unexpected lease kind" : renewed.reason}).`,
              );
              continue;
            }
            heldWorkerSlots.set(held.workerId, {
              ...held,
              lease: renewed.lease,
              renewedAtMs: Date.now(),
            });
            continue;
          }

          if (options.verify) {
            const verified = await coordination.verifyLease(held.lease);
            if (!verified.valid || verified.lease.kind !== "worker-slot") {
              await abandonLostWorkerSlotUnlocked(
                bound,
                held,
                `Worker-slot lease is no longer valid (${verified.valid ? "unexpected lease kind" : verified.reason}).`,
              );
              continue;
            }
            heldWorkerSlots.set(held.workerId, {
              ...held,
              lease: verified.lease,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await abandonLostWorkerSlotUnlocked(
            bound,
            held,
            `Could not prove worker-slot ownership: ${message}`,
          );
        }
      }
    });
  }

  /**
   * Promote the oldest completed worker waiting in the multi-worker list into
   * the single pendingDisposition slot. Skips while Integration is pending so
   * Close disposition cannot race a second Integration unit.
   */
  function promoteNextPendingDisposition(): void {
    if (pendingDisposition || pendingIntegration) return;
    for (const [workerId, worker] of activeImplementationWorkers) {
      if (worker.status !== "needs-disposition") continue;
      pendingDisposition = worker;
      activeImplementationWorkers.delete(workerId);
      return;
    }
  }

  function listImplementationWorkersForPanel(): ActiveImplementationWorker[] {
    const listed = [...activeImplementationWorkers.values()];
    if (pendingDisposition) {
      listed.push(pendingDisposition);
    }
    listed.sort((a, b) => {
      if (a.ticketNumber !== b.ticketNumber) {
        return a.ticketNumber - b.ticketNumber;
      }
      return a.attempt - b.attempt;
    });
    return listed;
  }

  function bindRoot(rootPath: string): void {
    if (
      selectedPath &&
      path.resolve(selectedPath) !== path.resolve(rootPath)
    ) {
      completedWorkerTelemetryByAttempt.clear();
      recoveredCompletedWorkerTranscriptKeys.clear();
    }
    selectedPath = rootPath;
    scoped = ports.forRoot(rootPath);
  }

  async function classifyRoot(
    rootPath: string,
    kind: WorkflowRootKind,
  ): Promise<WorkflowRoot> {
    const { environment } = ports.forRoot(rootPath);
    const hasSupportedTrackerRemote =
      await environment.hasSupportedTrackerRemote();
    if (!hasSupportedTrackerRemote) {
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
      if (scoped && selectedPath && selectedPath !== defaultRoot.path) {
        await abortWorkers();
        await releaseWorkflowHome();
        lastCompletedWorkflow = undefined;
      }
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
    environment?: RootScopedPorts["environment"],
  ): Promise<string> {
    const configured = await preferences.getConfiguredTargetBranch();
    if (configured) return configured;
    // Auto-detect primary branch (origin/HEAD → main/master/…) when unset.
    if (environment) {
      const detected = await environment.detectDefaultBranch();
      if (detected) return detected;
    }
    return DEFAULT_TARGET_BRANCH;
  }

  /**
   * Rebuild in-memory Integration / disposition state from transcripts so a new
   * /matt-auto run does not re-Implement tickets that already completed (or
   * already failed Integration after Close).
   */
  async function recoverPendingDispositionFromTranscripts(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<void> {
    if (
      pendingDisposition ||
      pendingIntegration ||
      activeImplementationWorkers.size > 0
    ) {
      return;
    }
    const ticketNumbers = active.tickets ?? [];
    const rootPath = selectedPath ?? ports.startPath;

    for (const ticketNumber of ticketNumbers) {
      if (
        (active.integratedTickets ?? []).some((t) => t.number === ticketNumber)
      ) {
        continue;
      }
      const attempt = await bound.workspace.latestAttempt(
        active.workflowId,
        ticketNumber,
      );
      if (attempt < 1) continue;

      const events = await bound.transcripts.read({
        workflowId: active.workflowId,
        ticketNumber,
        attempt,
      });
      const history = analyzeImplementationAttemptEvents(events);

      const branchName = implementationBranchName(
        active.workflowId,
        ticketNumber,
        attempt,
      );
      const worktreePath = implementationWorktreePath(
        rootPath,
        active.workflowId,
        ticketNumber,
        attempt,
      );

      // Prefer retrying Integration over re-Implementing when Close already
      // ran for a completed attempt. Covers failed/conflicted units and also
      // mid-unit interruption (pause after merge, before completed) where no
      // integration-unit-failed event was written.
      if (
        history.disposition === "close" &&
        history.implementCompleted &&
        !history.integrationComplete
      ) {
        pendingIntegration = {
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          branchName,
          worktreePath,
          lastFailure:
            history.integrationFailedReason ??
            "Close disposition is pending Integration for this attempt.",
          ...(history.integrationConflict
            ? { conflict: history.integrationConflict }
            : {}),
        };
        implementationRecoveryCooldown.delete(ticketNumber);
        return;
      }

      // Completed implement, never Closed (or Close not recorded).
      if (history.implementCompleted && history.disposition === undefined) {
        pendingDisposition = {
          workerId: `recovered-${active.workflowId}-${ticketNumber}-r${attempt}`,
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          branchName,
          worktreePath,
          status: "needs-disposition",
          startedAtMs: Date.now(),
          receivedStageResult: true,
          summary:
            history.summary ??
            (history.headSha
              ? `Recovered completed attempt r${attempt} @ ${history.headSha.slice(0, 8)}`
              : `Recovered completed attempt r${attempt}`),
        };
        implementationRecoveryCooldown.delete(ticketNumber);
        return;
      }
    }
  }

  /** Short TTL for Active workflow / ticket progress (full reads). */
  const TRACKER_READ_TTL_MS = 20_000;
  let workflowHomeRouteTtl:
    | {
        key: string;
        at: number;
        value: WorkflowHomeRoute;
      }
    | undefined;
  let ticketProgressTtl:
    | {
        key: string;
        at: number;
        value: TicketProgressSummary;
      }
    | undefined;

  function copyCanonicalTarget(
    target: CanonicalTargetIdentity,
  ): CanonicalTargetIdentity {
    return {
      repository: { ...target.repository },
      targetRef: target.targetRef,
    };
  }

  function coordinationRoutingSupported(bound: RootScopedPorts): boolean {
    return Boolean(
      bound.coordination &&
        bound.tracker.getCanonicalRepositoryIdentity &&
        bound.preferences.getWorkflowHomeBinding &&
        bound.preferences.setWorkflowHomeBinding &&
        bound.preferences.clearWorkflowHomeBinding,
    );
  }

  async function resolveCoordinationRoutingContext(
    bound: RootScopedPorts,
  ): Promise<CoordinationRoutingContext> {
    if (!coordinationRoutingSupported(bound)) {
      return { supported: false };
    }
    const resolveRepository = bound.tracker.getCanonicalRepositoryIdentity;
    if (!resolveRepository) {
      return { supported: true, ok: false, reason: "Canonical repository discovery is unavailable." };
    }
    const targetBranch = await resolveTargetBranch(
      bound.preferences,
      bound.environment,
    );
    const targetRef = targetRefFromBranch(targetBranch);
    if (!targetRef) {
      return {
        supported: true,
        ok: false,
        reason: `Target branch "${targetBranch}" cannot be represented as a canonical refs/heads Target ref.`,
      };
    }
    try {
      const repository = await resolveRepository();
      if (!repository || !isCanonicalRepositoryIdentity(repository)) {
        return {
          supported: true,
          ok: false,
          reason: "Could not resolve this Workflow root's canonical forge owner/name identity.",
        };
      }
      return {
        supported: true,
        ok: true,
        target: {
          repository: { ...repository },
          targetRef,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        supported: true,
        ok: false,
        reason: `Could not resolve this Workflow root's canonical forge identity: ${message}`,
      };
    }
  }

  async function ensureWorkflowHomeLock(
    bound: RootScopedPorts,
  ): Promise<{ ok: true } | { ok: false; reason: string; holderId?: string }> {
    const lockPort = bound.workflowHomeLock;
    if (!lockPort) return { ok: true };

    if (heldWorkflowHomeLock) {
      try {
        const renewed = await lockPort.renew(heldWorkflowHomeLock);
        if (renewed.renewed) {
          lastWorkflowHomeLockHeartbeatAtMs = Date.now();
          return { ok: true };
        }
      } catch {
        // Session-sticky lock memory can outlive the on-disk record after a
        // failed run; drop it and re-acquire rather than permanent unavailable.
      }
      // Lost renew: clear sticky memory and fall through to a fresh acquire so
      // same-session /matt-auto run can continue when the checkout is free.
      heldWorkflowHomeLock = undefined;
      lastWorkflowHomeLockHeartbeatAtMs = 0;
    }

    try {
      const acquired = await lockPort.acquire({ holderId: workflowHomeHolderId });
      if (!acquired.acquired) {
        return {
          ok: false,
          reason:
            "This checkout is already owned by another Workflow home. Use a separate clone or Git worktree for an independent Workflow home.",
          ...(acquired.holderId ? { holderId: acquired.holderId } : {}),
        };
      }
      heldWorkflowHomeLock = acquired.lock;
      lastWorkflowHomeLockHeartbeatAtMs = Date.now();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not acquire this checkout's Workflow-home guard: ${message}`,
      };
    }
  }

  async function heartbeatWorkflowHomeLock(
    bound: RootScopedPorts,
  ): Promise<void> {
    const lock = heldWorkflowHomeLock;
    if (
      !lock ||
      !bound.workflowHomeLock ||
      Date.now() - lastWorkflowHomeLockHeartbeatAtMs <
        DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    try {
      const renewed = await bound.workflowHomeLock.renew(lock);
      if (renewed.renewed) {
        lastWorkflowHomeLockHeartbeatAtMs = Date.now();
      } else {
        heldWorkflowHomeLock = undefined;
        lastWorkflowHomeLockHeartbeatAtMs = 0;
      }
    } catch {
      heldWorkflowHomeLock = undefined;
      lastWorkflowHomeLockHeartbeatAtMs = 0;
    }
  }

  async function withWorkflowCoordinatorLeaseMutex<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = workflowCoordinatorLeaseMutex;
    let unlock: (() => void) | undefined;
    workflowCoordinatorLeaseMutex = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock?.();
    }
  }

  async function releaseHeldWorkflowCoordinatorLeaseUnlocked(
    bound: RootScopedPorts | undefined,
  ): Promise<void> {
    stopWorkflowCoordinatorHeartbeat();
    const held = heldWorkflowCoordinatorLease;
    heldWorkflowCoordinatorLease = undefined;
    if (!held || !bound?.coordination) return;
    try {
      await bound.coordination.releaseLease(held.lease);
    } catch {
      // TTL expiry is the fail-closed recovery path when a release cannot reach
      // the remote coordination ref.
    }
  }

  async function releaseHeldWorkflowCoordinatorLease(
    bound: RootScopedPorts | undefined,
  ): Promise<void> {
    await withWorkflowCoordinatorLeaseMutex(() =>
      releaseHeldWorkflowCoordinatorLeaseUnlocked(bound),
    );
  }

  async function ensureWorkflowCoordinatorLeaseUnlocked(
    bound: RootScopedPorts,
    target: CanonicalTargetIdentity,
    workflowId: number,
  ): Promise<WorkflowCoordinatorLeaseCheck> {
    const coordination = bound.coordination;
    if (!coordination) {
      return {
        ok: false,
        reason:
          "Remote Workflow coordinator leasing is unavailable for this coordination-aware workflow.",
      };
    }

    const local = await ensureWorkflowHomeLock(bound);
    if (!local.ok) {
      return {
        ok: false,
        reason: local.reason,
        ...(local.holderId ? { holderId: local.holderId } : {}),
      };
    }

    const targetKey = canonicalTargetIdentityKey(target);
    let lease = heldWorkflowCoordinatorLease;
    if (
      lease &&
      (lease.workflowId !== workflowId ||
        canonicalTargetIdentityKey(lease.target) !== targetKey)
    ) {
      await releaseHeldWorkflowCoordinatorLeaseUnlocked(bound);
      lease = undefined;
    }

    try {
      if (!lease) {
        const acquired = await coordination.acquireLease({
          kind: "workflow-coordinator",
          repository: target.repository,
          target,
          workflowId,
          holderId: workflowHomeHolderId,
        });
        if (!acquired.acquired || acquired.lease.kind !== "workflow-coordinator") {
          return {
            ok: false,
            reason: `Workflow #${workflowId} is already operated by another Workflow home. Resume it only after that home releases or its coordinator lease expires.`,
            ...(!acquired.acquired && acquired.lease
              ? { holderId: acquired.lease.holderId }
              : {}),
          };
        }
        lease = {
          target: copyCanonicalTarget(target),
          workflowId,
          lease: acquired.lease,
          renewedAtMs: Date.now(),
        };
        heldWorkflowCoordinatorLease = lease;
        coordinatorLeaseLost = false;
      } else if (
        Date.now() - lease.renewedAtMs >=
        DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS
      ) {
        const renewed = await coordination.renewLease({ lease: lease.lease });
        if (!renewed.renewed) {
          heldWorkflowCoordinatorLease = undefined;
          coordinatorLeaseLost = true;
          return {
            ok: false,
            reason: `Workflow #${workflowId} coordinator lease could not be renewed (${renewed.reason}). Remote mutation is blocked until it is explicitly resumed.`,
            ...(renewed.lease ? { holderId: renewed.lease.holderId } : {}),
          };
        }
        if (renewed.lease.kind !== "workflow-coordinator") {
          heldWorkflowCoordinatorLease = undefined;
          coordinatorLeaseLost = true;
          return {
            ok: false,
            reason: `Workflow #${workflowId} coordinator lease renewal returned an unexpected lease kind. Remote mutation is blocked until it is explicitly resumed.`,
          };
        }
        lease = {
          ...lease,
          lease: renewed.lease,
          renewedAtMs: Date.now(),
        };
        heldWorkflowCoordinatorLease = lease;
      }

      const verified = await coordination.verifyLease(lease.lease);
      if (!verified.valid) {
        heldWorkflowCoordinatorLease = undefined;
        coordinatorLeaseLost = true;
        return {
          ok: false,
          reason: `Workflow #${workflowId} coordinator lease is no longer valid (${verified.reason}). Remote mutation is blocked until it is explicitly resumed.`,
          ...(verified.lease ? { holderId: verified.lease.holderId } : {}),
        };
      }
      if (verified.lease.kind !== "workflow-coordinator") {
        heldWorkflowCoordinatorLease = undefined;
        coordinatorLeaseLost = true;
        return {
          ok: false,
          reason: `Workflow #${workflowId} coordinator lease verification returned an unexpected lease kind. Remote mutation is blocked until it is explicitly resumed.`,
        };
      }
      lease = {
        ...lease,
        lease: verified.lease,
      };
      heldWorkflowCoordinatorLease = lease;
      coordinatorLeaseLost = false;
      return { ok: true, lease: lease.lease };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not verify Workflow #${workflowId} coordinator lease: ${message}`,
      };
    }
  }

  async function ensureWorkflowCoordinatorLease(
    bound: RootScopedPorts,
    target: CanonicalTargetIdentity,
    workflowId: number,
  ): Promise<WorkflowCoordinatorLeaseCheck> {
    return withWorkflowCoordinatorLeaseMutex(() =>
      ensureWorkflowCoordinatorLeaseUnlocked(bound, target, workflowId),
    );
  }

  /** Best-effort heartbeat while a live panel or worker event keeps this home active. */
  async function heartbeatHeldWorkflowCoordinatorLease(
    bound: RootScopedPorts,
  ): Promise<void> {
    const held = heldWorkflowCoordinatorLease;
    if (!held) return;
    await heartbeatWorkflowHomeLock(bound);
    // A shutdown/root switch may have released this lease while awaiting the
    // local heartbeat. Never reacquire it from a stale timer callback.
    if (heldWorkflowCoordinatorLease !== held) return;
    if (
      Date.now() - held.renewedAtMs <
      DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    await ensureWorkflowCoordinatorLease(bound, held.target, held.workflowId);
  }

  function stopWorkflowCoordinatorHeartbeat(): void {
    if (workflowCoordinatorHeartbeatTimer) {
      clearInterval(workflowCoordinatorHeartbeatTimer);
      workflowCoordinatorHeartbeatTimer = undefined;
    }
    workflowCoordinatorHeartbeatUsers = 0;
  }

  /** Keep a held lease alive across one long local operation without pinning Node's event loop. */
  function startWorkflowCoordinatorHeartbeat(
    bound: RootScopedPorts,
  ): () => void {
    if (!heldWorkflowCoordinatorLease) return () => {};
    workflowCoordinatorHeartbeatUsers += 1;
    if (!workflowCoordinatorHeartbeatTimer) {
      workflowCoordinatorHeartbeatTimer = setInterval(() => {
        if (workflowCoordinatorHeartbeatInFlight) return;
        workflowCoordinatorHeartbeatInFlight = true;
        void heartbeatHeldWorkflowCoordinatorLease(bound).finally(() => {
          workflowCoordinatorHeartbeatInFlight = false;
        });
      }, Math.max(
        1_000,
        Math.floor(DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS / 2),
      ));
      workflowCoordinatorHeartbeatTimer.unref();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      workflowCoordinatorHeartbeatUsers = Math.max(
        0,
        workflowCoordinatorHeartbeatUsers - 1,
      );
      if (workflowCoordinatorHeartbeatUsers === 0) {
        stopWorkflowCoordinatorHeartbeat();
      }
    };
  }

  async function ensureActiveWorkflowCoordinatorLease(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<WorkflowCoordinatorLeaseCheck | { ok: true; lease?: undefined }> {
    if (!active.coordination) return { ok: true };
    const getBinding = bound.preferences.getWorkflowHomeBinding;
    if (!getBinding) {
      return {
        ok: false,
        reason:
          "This Workflow home cannot read its local canonical binding for a coordination-aware workflow.",
      };
    }
    let binding: WorkflowHomeBinding | undefined;
    try {
      binding = await getBinding(active.coordination.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not read this Workflow home's local binding: ${message}`,
      };
    }
    if (
      !binding ||
      binding.workflowId !== active.workflowId ||
      canonicalTargetIdentityKey(binding.target) !==
        canonicalTargetIdentityKey(active.coordination.target)
    ) {
      return {
        ok: false,
        reason: `Workflow #${active.workflowId} is not bound to this Workflow home. Choose an explicit Resume action before operating it.`,
      };
    }
    return ensureWorkflowCoordinatorLease(
      bound,
      active.coordination.target,
      active.workflowId,
    );
  }

  async function persistWorkflowHomeBinding(
    bound: RootScopedPorts,
    target: CanonicalTargetIdentity,
    workflowId: number,
  ): Promise<void> {
    const setBinding = bound.preferences.setWorkflowHomeBinding;
    if (!setBinding) {
      throw new Error(
        "This Workflow home cannot persist canonical local bindings for coordination-aware workflows.",
      );
    }
    await setBinding({ target: copyCanonicalTarget(target), workflowId });
  }

  async function clearWorkflowHomeBinding(
    bound: RootScopedPorts,
    target: CanonicalTargetIdentity,
  ): Promise<void> {
    const clearBinding = bound.preferences.clearWorkflowHomeBinding;
    if (!clearBinding) return;
    await clearBinding(target);
  }

  async function loadLegacyWorkflowRoute(
    bound: RootScopedPorts,
    targetBranch: string,
    options: { force?: boolean },
  ): Promise<WorkflowHomeRoute> {
    const hint = await bound.preferences.getActiveWorkflowId(targetBranch);
    const cacheKey = `legacy:${targetBranch}:${hint ?? ""}`;
    const now = Date.now();
    if (
      !options.force &&
      workflowHomeRouteTtl &&
      workflowHomeRouteTtl.key === cacheKey &&
      now - workflowHomeRouteTtl.at < TRACKER_READ_TTL_MS
    ) {
      return workflowHomeRouteTtl.value;
    }
    // Preserve version-1 behavior during temporary tracker GraphQL backoff.
    if (
      !options.force &&
      isInGraphqlBackoff() &&
      workflowHomeRouteTtl &&
      workflowHomeRouteTtl.key === cacheKey
    ) {
      return workflowHomeRouteTtl.value;
    }

    const active = await bound.tracker.findActiveWorkflow(targetBranch, hint);
    if (active?.coordination) {
      return {
        kind: "unavailable",
        reason:
          "This coordination-aware workflow requires canonical Workflow-home binding and a remote CoordinationPort; legacy routing will not operate it.",
      };
    }
    if (active) {
      const local = await ensureWorkflowHomeLock(bound);
      if (!local.ok) {
        return { kind: "unavailable", reason: local.reason };
      }
      await bound.preferences.setActiveWorkflowId(targetBranch, active.workflowId);
    } else if (hint !== undefined) {
      await bound.preferences.clearActiveWorkflowId(targetBranch);
    }
    const route: WorkflowHomeRoute = { kind: "legacy", ...(active ? { active } : {}) };
    workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
    return route;
  }

  async function loadWorkflowHomeRoute(
    bound: RootScopedPorts,
    options: { force?: boolean } = {},
  ): Promise<WorkflowHomeRoute> {
    const context = await resolveCoordinationRoutingContext(bound);
    if (!context.supported) {
      const targetBranch = await resolveTargetBranch(
        bound.preferences,
        bound.environment,
      );
      return loadLegacyWorkflowRoute(bound, targetBranch, options);
    }
    if (!context.ok) {
      return { kind: "unavailable", reason: context.reason };
    }

    const target = context.target;
    const targetBranch = await resolveTargetBranch(
      bound.preferences,
      bound.environment,
    );
    const cacheKey = `coordination:${canonicalTargetIdentityKey(target)}`;
    const now = Date.now();
    if (
      !options.force &&
      workflowHomeRouteTtl &&
      workflowHomeRouteTtl.key === cacheKey &&
      now - workflowHomeRouteTtl.at < TRACKER_READ_TTL_MS
    ) {
      return workflowHomeRouteTtl.value;
    }

    let candidates: readonly ActiveWorkflow[];
    try {
      candidates = await bound.tracker.findActiveWorkflows(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "unavailable",
        reason: `Could not discover Active workflows for this canonical Target: ${message}`,
      };
    }

    const getBinding = bound.preferences.getWorkflowHomeBinding;
    const legacyHint = await bound.preferences.getActiveWorkflowId(targetBranch);
    let binding: WorkflowHomeBinding | undefined;
    try {
      binding = getBinding ? await getBinding(target) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "unavailable",
        reason: `Could not read this Workflow home's local binding: ${message}`,
      };
    }

    if (binding) {
      const active = candidates.find(
        (candidate) => candidate.workflowId === binding!.workflowId,
      );
      if (!active) {
        try {
          await clearWorkflowHomeBinding(bound, target);
        } catch {
          // The binding is already known stale; selection still fails closed.
        }
        const route: WorkflowHomeRoute = {
          kind: "selection-required",
          target,
          candidates,
          staleBinding: binding,
        };
        workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
        return route;
      }
      // Version-1 manifests remain on their documented legacy path, while
      // still taking the local checkout guard before they can be operated.
      if (!active.coordination) {
        const local = await ensureWorkflowHomeLock(bound);
        if (!local.ok) return { kind: "unavailable", reason: local.reason };
        const route: WorkflowHomeRoute = { kind: "legacy", active };
        workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
        return route;
      }
      const lease = await ensureWorkflowCoordinatorLease(
        bound,
        target,
        active.workflowId,
      );
      const route: WorkflowHomeRoute = lease.ok
        ? { kind: "bound", active, target }
        : {
            kind: "lease-held",
            target,
            active,
            ...(lease.holderId ? { holderId: lease.holderId } : {}),
          };
      workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
      return route;
    }

    // Upgrade an existing explicit v1-era local pointer into the new canonical
    // binding only when it names a concrete coordination-aware manifest. It is
    // migration, not arbitrary selection by result order.
    if (legacyHint !== undefined) {
      const pointed = candidates.find(
        (candidate) => candidate.workflowId === legacyHint,
      );
      if (pointed?.coordination) {
        const lease = await ensureWorkflowCoordinatorLease(
          bound,
          target,
          pointed.workflowId,
        );
        if (lease.ok) {
          try {
            await persistWorkflowHomeBinding(bound, target, pointed.workflowId);
            const route: WorkflowHomeRoute = {
              kind: "bound",
              active: pointed,
              target,
            };
            workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
            return route;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              kind: "unavailable",
              reason: `Could not migrate this Workflow home's legacy pointer to a canonical binding: ${message}`,
            };
          }
        }
        return {
          kind: "lease-held",
          target,
          active: pointed,
          ...(lease.holderId ? { holderId: lease.holderId } : {}),
        };
      }
      if (pointed && !pointed.coordination) {
        const local = await ensureWorkflowHomeLock(bound);
        if (!local.ok) return { kind: "unavailable", reason: local.reason };
        const route: WorkflowHomeRoute = { kind: "legacy", active: pointed };
        workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
        return route;
      }
      await bound.preferences.clearActiveWorkflowId(targetBranch);
    }

    // Existing v1 manifests retain their legacy single-workflow startup path.
    const onlyCandidate = candidates[0];
    if (
      candidates.length === 1 &&
      onlyCandidate !== undefined &&
      !onlyCandidate.coordination
    ) {
      const local = await ensureWorkflowHomeLock(bound);
      if (!local.ok) return { kind: "unavailable", reason: local.reason };
      const route: WorkflowHomeRoute = { kind: "legacy", active: onlyCandidate };
      workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
      return route;
    }

    const route: WorkflowHomeRoute = {
      kind: "selection-required",
      target,
      candidates,
    };
    workflowHomeRouteTtl = { key: cacheKey, at: now, value: route };
    return route;
  }

  async function loadActiveWorkflow(
    bound: RootScopedPorts,
    options: { force?: boolean } = {},
  ): Promise<ActiveWorkflow | undefined> {
    const route = await loadWorkflowHomeRoute(bound, options);
    return route.kind === "legacy" || route.kind === "bound"
      ? route.active
      : undefined;
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
    return isPublishableSpecDraft(draft);
  }

  function validateTicketsDraft(
    draft: TicketsDraft,
  ): { ok: true; tickets: TicketDraft[] } | { ok: false; reason: string } {
    if (!draft.tickets || draft.tickets.length === 0) {
      return {
        ok: false,
        reason:
          "Create-tickets skill returned an empty breakdown. Matt Auto entered Compatibility recovery rather than publishing.",
      };
    }

    const seen = new Set<string>();
    const tickets: TicketDraft[] = [];

    for (const raw of draft.tickets) {
      const localId = raw.localId?.trim() ?? "";
      const title = raw.title?.trim() ?? "";
      const body = raw.body ?? "";
      if (!localId) {
        return {
          ok: false,
          reason:
            "Create-tickets skill returned a ticket missing a localId. Matt Auto entered Compatibility recovery rather than publishing.",
        };
      }
      if (seen.has(localId)) {
        return {
          ok: false,
          reason: `Create-tickets skill returned duplicate localId "${localId}". Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      seen.add(localId);
      if (!title) {
        return {
          ok: false,
          reason: `Create-tickets skill returned ticket "${localId}" without a title. Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      if (!body.trim()) {
        return {
          ok: false,
          reason: `Create-tickets skill returned ticket "${localId}" without a body. Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      tickets.push({
        localId,
        title,
        body,
        blockedBy: [...(raw.blockedBy ?? [])],
      });
    }

    const ids = new Set(tickets.map((t) => t.localId));
    for (const ticket of tickets) {
      for (const blocker of ticket.blockedBy) {
        if (!ids.has(blocker)) {
          return {
            ok: false,
            reason: `Create-tickets skill returned ticket "${ticket.localId}" blocked by unknown localId "${blocker}". Matt Auto entered Compatibility recovery rather than publishing.`,
          };
        }
        if (blocker === ticket.localId) {
          return {
            ok: false,
            reason: `Create-tickets skill returned ticket "${ticket.localId}" blocked by itself. Matt Auto entered Compatibility recovery rather than publishing.`,
          };
        }
      }
    }

    // Cycle detection via DFS.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(tickets.map((t) => [t.localId, t]));

    function hasCycle(id: string): boolean {
      if (visited.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const node = byId.get(id);
      for (const blocker of node?.blockedBy ?? []) {
        if (hasCycle(blocker)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }

    for (const ticket of tickets) {
      if (hasCycle(ticket.localId)) {
        return {
          ok: false,
          reason:
            "Create-tickets skill returned a cyclic blockedBy graph. Matt Auto entered Compatibility recovery rather than publishing.",
        };
      }
    }

    return { ok: true, tickets };
  }

  /** Topological order: blockers before dependents (stable by input order). */
  function topologicalOrder(tickets: readonly TicketDraft[]): TicketDraft[] {
    const byId = new Map(tickets.map((t) => [t.localId, t]));
    const remaining = new Set(tickets.map((t) => t.localId));
    const ordered: TicketDraft[] = [];

    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => {
        const ticket = byId.get(id);
        return (ticket?.blockedBy ?? []).every((b) => !remaining.has(b));
      });
      // Preserve original relative order among ready tickets.
      const readyInOrder = tickets.filter((t) => ready.includes(t.localId));
      if (readyInOrder.length === 0) {
        // Should be unreachable after cycle validation.
        break;
      }
      for (const ticket of readyInOrder) {
        ordered.push(ticket);
        remaining.delete(ticket.localId);
      }
    }

    return ordered;
  }

  function stripManagedSections(body: string): string {
    // Remove Parent / Blocked by sections the skill may have drafted so publish
    // can write canonical GitHub references.
    return body
      .split(/(?=^##\s)/m)
      .filter((section) => {
        const header = /^##\s*(.+?)(?:\r?\n|$)/.exec(section);
        const name = header?.[1]?.trim().toLowerCase();
        return name !== "parent" && name !== "blocked by";
      })
      .join("")
      .trim();
  }

  function formatPublishedTicketBody(
    draft: TicketDraft,
    workflowId: number,
    workflowTitle: string | undefined,
    blockers: readonly { number: number; title: string }[],
  ): string {
    const parentLine = workflowTitle
      ? `#${workflowId} ${workflowTitle}`
      : `#${workflowId}`;
    const core = stripManagedSections(draft.body);
    const blockedBySection =
      blockers.length === 0
        ? "None — can start immediately."
        : blockers.map((b) => `- #${b.number} ${b.title}`).join("\n");

    return [
      "## Parent",
      "",
      parentLine,
      "",
      core,
      "",
      "## Blocked by",
      "",
      blockedBySection,
      "",
    ].join("\n");
  }

  function computeTicketProgress(
    workflowId: number,
    tickets: readonly TrackerTicket[],
    integratedNumbers: ReadonlySet<number> = new Set(),
  ): TicketProgressSummary {
    const open = tickets.filter((t) => t.state === "OPEN");
    const closed = tickets.filter((t) => t.state === "CLOSED");

    const ready: ReadyTicket[] = [];
    const blocked: TicketProgressSummary["blocked"][number][] = [];
    const awaitingCi: ReadyTicket[] = [];
    const items: TicketProgressSummary["items"][number][] = [];

    const sortedAll = [...tickets].sort((a, b) => a.number - b.number);
    const sortedOpen = [...open].sort((a, b) => a.number - b.number);

    for (const ticket of sortedOpen) {
      if (integratedNumbers.has(ticket.number)) {
        awaitingCi.push({ number: ticket.number, title: ticket.title });
        continue;
      }

      const openBlockers = ticket.blockedBy
        .filter((b) => b.state === "OPEN")
        .map((b) => b.number)
        .sort((a, b) => a - b);

      if (openBlockers.length === 0) {
        ready.push({ number: ticket.number, title: ticket.title });
      } else {
        blocked.push({
          number: ticket.number,
          title: ticket.title,
          openBlockers,
        });
      }
    }

    for (const ticket of sortedAll) {
      if (ticket.state === "CLOSED") {
        items.push({
          number: ticket.number,
          title: ticket.title,
          state: "CLOSED",
          status: "closed",
        });
        continue;
      }
      if (integratedNumbers.has(ticket.number)) {
        items.push({
          number: ticket.number,
          title: ticket.title,
          state: "OPEN",
          status: "awaiting-ci",
        });
        continue;
      }
      const openBlockers = ticket.blockedBy
        .filter((b) => b.state === "OPEN")
        .map((b) => b.number)
        .sort((a, b) => a - b);
      if (openBlockers.length === 0) {
        items.push({
          number: ticket.number,
          title: ticket.title,
          state: "OPEN",
          status: "ready",
        });
      } else {
        items.push({
          number: ticket.number,
          title: ticket.title,
          state: "OPEN",
          status: "blocked",
          openBlockers,
        });
      }
    }

    return {
      workflowId,
      total: tickets.length,
      open: open.length,
      closed: closed.length,
      ready,
      blocked,
      awaitingCi,
      items,
    };
  }

  function isTicketWorkStage(stage: WorkflowStage): boolean {
    return stage === "tickets-published" || stage === "pr-opened";
  }

  function allTicketsComplete(progress: TicketProgressSummary): boolean {
    return (
      progress.total > 0 &&
      progress.closed === progress.total &&
      progress.open === 0 &&
      progress.awaitingCi.length === 0 &&
      progress.ready.length === 0
    );
  }

  function manifestFromActive(
    active: ActiveWorkflow,
    overrides: Partial<WorkflowManifest> = {},
  ): WorkflowManifest {
    const manifest: WorkflowManifest = active.coordination
      ? {
          schema: WORKFLOW_MANIFEST_SCHEMA,
          version: 2,
          workflowId: active.workflowId,
          targetBranch: active.targetBranch,
          stage: overrides.stage ?? active.stage,
          workerProfile: active.workerProfile,
          coordination: {
            target: copyCanonicalTarget(active.coordination.target),
            ...(active.coordination.prFreshness
              ? { prFreshness: { ...active.coordination.prFreshness } }
              : {}),
            ...(active.coordination.queueCandidate
              ? {
                  queueCandidate: structuredClone(
                    active.coordination.queueCandidate,
                  ),
                }
              : {}),
            ...(active.coordination.observedLeaseGenerations
              ? {
                  observedLeaseGenerations: {
                    ...active.coordination.observedLeaseGenerations,
                  },
                }
              : {}),
          },
        }
      : {
          schema: WORKFLOW_MANIFEST_SCHEMA,
          version: 1,
          workflowId: active.workflowId,
          targetBranch: active.targetBranch,
          stage: overrides.stage ?? active.stage,
          workerProfile: active.workerProfile,
        };
    const tickets = overrides.tickets ?? active.tickets;
    if (tickets) {
      manifest.tickets = [...tickets];
    }
    const integrationBranch =
      overrides.integrationBranch ?? active.integrationBranch;
    if (integrationBranch) {
      manifest.integrationBranch = integrationBranch;
    }
    const integratedTickets =
      overrides.integratedTickets ?? active.integratedTickets;
    if (integratedTickets) {
      manifest.integratedTickets = [...integratedTickets];
    }
    const workflowPr =
      overrides.workflowPr !== undefined
        ? overrides.workflowPr
        : active.workflowPr;
    if (workflowPr) {
      manifest.workflowPr = { ...workflowPr };
    }
    const followUpOf =
      overrides.followUpOf !== undefined
        ? overrides.followUpOf
        : active.followUpOf;
    if (followUpOf !== undefined) {
      manifest.followUpOf = followUpOf;
    }
    return manifest;
  }

  function manifestWithCoordinatorLeaseGeneration(
    manifest: WorkflowManifest,
    lease: WorkflowCoordinatorLease | undefined,
  ): WorkflowManifest {
    if (!lease || manifest.version !== 2) return manifest;
    return {
      ...manifest,
      coordination: {
        ...manifest.coordination,
        target: copyCanonicalTarget(manifest.coordination.target),
        observedLeaseGenerations: {
          ...manifest.coordination.observedLeaseGenerations,
          workflowCoordinator: lease.generation,
        },
      },
    };
  }

  async function loadTicketProgress(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
    options: { force?: boolean } = {},
  ): Promise<TicketProgressSummary | undefined> {
    if (!isTicketWorkStage(active.stage) && active.stage !== "merged") {
      return undefined;
    }
    const numbers = active.tickets ?? [];
    const integratedNumbers = new Set(
      (active.integratedTickets ?? []).map((t) => t.number),
    );
    if (numbers.length === 0) {
      return {
        workflowId: active.workflowId,
        total: 0,
        open: 0,
        closed: 0,
        ready: [],
        blocked: [],
        awaitingCi: [],
        items: [],
      };
    }

    const cacheKey = `${active.workflowId}:${numbers.join(",")}:${[...integratedNumbers].sort((a, b) => a - b).join(",")}`;
    const now = Date.now();
    if (
      !options.force &&
      ticketProgressTtl &&
      ticketProgressTtl.key === cacheKey &&
      now - ticketProgressTtl.at < TRACKER_READ_TTL_MS
    ) {
      return ticketProgressTtl.value;
    }
    if (
      !options.force &&
      isInGraphqlBackoff() &&
      ticketProgressTtl &&
      ticketProgressTtl.key === cacheKey
    ) {
      return ticketProgressTtl.value;
    }

    try {
      const tickets = await bound.tracker.listTickets(numbers);
      const progress = computeTicketProgress(
        active.workflowId,
        tickets,
        integratedNumbers,
      );
      ticketProgressTtl = { key: cacheKey, at: now, value: progress };
      cachedTicketProgress = {
        workflowId: active.workflowId,
        progress,
      };
      return progress;
    } catch {
      // Rate limit or transient tracker failure: serve stale progress if any.
      if (ticketProgressTtl && ticketProgressTtl.key === cacheKey) {
        return ticketProgressTtl.value;
      }
      if (
        cachedTicketProgress &&
        cachedTicketProgress.workflowId === active.workflowId
      ) {
        return cachedTicketProgress.progress;
      }
      return undefined;
    }
  }

  function formatTicketProgressAction(
    progress: TicketProgressSummary,
  ): NextAction {
    const readyList =
      progress.ready.length === 0
        ? "none"
        : progress.ready.map((t) => `#${t.number}`).join(", ");
    return {
      id: TICKET_PROGRESS_ACTION.id,
      label: `${TICKET_PROGRESS_ACTION.label}: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed`,
      description: `Ready frontier: ${readyList}.`,
    };
  }

  function formatImplementAction(ticket: ReadyTicket): NextAction {
    return {
      id: implementTicketActionId(ticket.number),
      label: `Implement #${ticket.number}`,
      description: `${ticket.title}. Launch a session-owned Implementation worker in an isolated Implementation workspace.`,
    };
  }

  function panelLines(
    workflowId: number,
    progress: TicketProgressSummary | undefined,
    workers: readonly ActiveImplementationWorker[],
  ): string[] {
    const lines = [`Workflow #${workflowId}`];
    if (progress) {
      lines.push(
        `Tickets: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed`,
      );
    }
    for (const worker of workers) {
      const progressText = worker.progress ? ` — ${worker.progress}` : "";
      lines.push(
        `Worker #${worker.ticketNumber} r${worker.attempt}: ${worker.status}${progressText}`,
      );
    }
    if (activeConflictWorker) {
      const progressText = activeConflictWorker.progress
        ? ` — ${activeConflictWorker.progress}`
        : "";
      if (activeConflictWorker.resolutionKind === "target-refresh") {
        lines.push(
          `Target-refresh conflict r${activeConflictWorker.attempt}: ${activeConflictWorker.status}${progressText}`,
        );
      } else {
        lines.push(
          `Conflict resolution #${activeConflictWorker.ticketNumber} r${activeConflictWorker.attempt}: ${activeConflictWorker.status}${progressText}`,
        );
      }
    } else if (pendingTargetRefresh) {
      const failure = pendingTargetRefresh.lastFailure
        ? ` — ${pendingTargetRefresh.lastFailure}`
        : "";
      lines.push(
        `Target-refresh r${pendingTargetRefresh.attempt}: ${targetRefreshInProgress ? "running" : "pending-retry"}${failure}`,
      );
    } else if (pendingIntegration) {
      const failure = pendingIntegration.lastFailure
        ? ` — ${pendingIntegration.lastFailure}`
        : "";
      lines.push(
        `Integration #${pendingIntegration.ticketNumber} r${pendingIntegration.attempt}: pending-retry${failure}`,
      );
    }
    if (pendingCiRecovery) {
      const detail = pendingCiRecovery.summary
        ? ` — ${pendingCiRecovery.summary}`
        : "";
      lines.push(
        `CI #${pendingCiRecovery.ticketNumber} r${pendingCiRecovery.attempt}: failure${detail}`,
      );
    } else if (progress && progress.awaitingCi.length > 0) {
      const list = progress.awaitingCi.map((t) => `#${t.number}`).join(", ");
      lines.push(`CI awaiting check: ${list}`);
    }
    return lines;
  }

  function appendWorkflowPrPanelLines(
    lines: string[],
    active: ActiveWorkflow,
  ): void {
    if (active.stage === "merged" && active.workflowPr) {
      lines.push(
        `Workflow PR #${active.workflowPr.number}: merged → ${active.workflowPr.baseBranch} (cleanup pending)`,
      );
      return;
    }
    if (active.workflowPr) {
      lines.push(
        `Workflow PR #${active.workflowPr.number}: open → ${active.workflowPr.baseBranch}`,
      );
    }
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

  async function invokeCreateTickets(
    bound: RootScopedPorts,
    workflowId: number,
    workflowTitle?: string,
  ): Promise<StageResult> {
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);
    let outcome;
    try {
      outcome = await bound.skills.runCreateTickets({
        workflowId,
        ...(workflowTitle ? { title: workflowTitle } : {}),
      });
    } finally {
      stopHeartbeat();
    }
    if (!outcome.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-tickets",
        reason: outcome.reason,
      };
    }

    const validated = validateTicketsDraft(outcome.draft);
    if (!validated.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-tickets",
        reason: validated.reason,
      };
    }

    const draft: TicketsDraft = { tickets: validated.tickets };
    pending = {
      stage: "create-tickets",
      draft,
      workflowId,
      ...(workflowTitle ? { workflowTitle } : {}),
    };
    return {
      status: "needs-confirmation",
      stage: "create-tickets",
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

  // Full delivery diagnostics are operator-triggered and may inspect remote
  // policy. Cache only that expensive scope; passive surfaces use overview.
  let preflightCache:
    | { result: PreflightResult; at: number; rootPath: string }
    | undefined;
  const PREFLIGHT_TTL_MS = 60_000;

  async function collectProtectedBranchAutomationChecks(
    bound: RootScopedPorts,
    targetBranch: string,
  ): Promise<PreflightCheck[]> {
    let policy: ProtectedBranchAutomationPolicy = {};
    try {
      if (typeof bound.tracker.inspectProtectedBranchAutomation === "function") {
        policy = await bound.tracker.inspectProtectedBranchAutomation({
          targetBranch,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          id: "canonical-repository",
          ok: false,
          guidance: `Could not inspect protected-branch automation policy: ${message}`,
        },
      ];
    }

    if (!policy.repository && typeof bound.tracker.getCanonicalRepositoryIdentity === "function") {
      try {
        const repository = await bound.tracker.getCanonicalRepositoryIdentity();
        if (repository) {
          const targetRef =
            policy.targetRef ?? targetRefFromBranch(targetBranch);
          policy = {
            ...policy,
            repository,
            ...(targetRef ? { targetRef } : {}),
          };
        }
      } catch {
        // Evaluator fail-closes when repository identity is absent.
      }
    }

    if (policy.coordinationRefsWritable === undefined) {
      if (bound.coordination?.canWriteCoordinationRefs && policy.repository) {
        try {
          const probe = await bound.coordination.canWriteCoordinationRefs(
            policy.repository,
          );
          policy = {
            ...policy,
            coordinationRefsWritable: probe.ok,
          };
        } catch {
          policy = { ...policy, coordinationRefsWritable: false };
        }
      } else if (!bound.coordination) {
        // Legacy single-workflow homes without a CoordinationPort skip the
        // coordination-ref check by treating it as not required here; the pure
        // evaluator still requires an explicit true, so mark writable only when
        // no coordination port is configured (v1 path).
        policy = { ...policy, coordinationRefsWritable: true };
      } else {
        policy = { ...policy, coordinationRefsWritable: false };
      }
    }

    return evaluateProtectedBranchAutomation(policy).checks;
  }

  /**
   * Merge-only policy gate. Other actions must not be blocked by unknown
   * merge settings, protection, or merge authority.
   */
  async function requireAutomaticMergeReadiness(
    bound: RootScopedPorts,
    targetBranch: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const checks = await collectProtectedBranchAutomationChecks(
      bound,
      targetBranch,
    );
    const failed = checks.filter((check) => !check.ok);
    if (failed.length === 0) return { ok: true };
    return {
      ok: false,
      reason: [
        "Automatic Workflow PR merge readiness is incomplete.",
        ...failed.map((check) => `${check.id}: ${check.guidance}`),
      ].join("\n"),
    };
  }

  async function resolveRepositoryMergeMethod(
    bound: RootScopedPorts,
    targetBranch: string,
  ): Promise<
    | { ok: true; mergeMethod: WorkflowMergeMethod }
    | { ok: false; reason: string }
  > {
    if (typeof bound.tracker.inspectProtectedBranchAutomation !== "function") {
      return {
        ok: false,
        reason:
          "Repository merge-method inspection is unavailable; Matt Auto will not hard-code a merge strategy.",
      };
    }
    try {
      const policy = await bound.tracker.inspectProtectedBranchAutomation({
        targetBranch,
      });
      const evaluated = evaluateProtectedBranchAutomation({
        ...policy,
        // Merge-method selection only — do not require full automation green.
        coordinationRefsWritable: true,
        actorCanMergeWithoutApproval: true,
        staleBaseProtectionGuaranteed: true,
        requiredApprovingReviewCount: 0,
        mergeQueueRequired: false,
        requiredStatusChecks: policy.requiredStatusChecks ?? {
          strict: true,
          contexts: ["ci"],
        },
      });
      if (!evaluated.mergeMethod) {
        return {
          ok: false,
          reason:
            "No supported repository merge method is enabled (merge, squash, or rebase).",
        };
      }
      return { ok: true, mergeMethod: evaluated.mergeMethod };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Could not resolve repository-configured merge method: ${message}`,
      };
    }
  }

  async function preflight(
    scope: PreflightScope = "delivery",
  ): Promise<PreflightResult> {
    const bound = await requireScoped();
    const targetBranch = await resolveTargetBranch(
      bound.preferences,
      bound.environment,
    );

    // Passive Home/dashboard views must not consume remote policy quota or
    // turn a final-delivery problem into an all-action pipeline blocker.
    if (scope === "overview") {
      const workerProfile = await resolveWorkerProfile(bound);
      return {
        ok: true,
        targetBranch,
        checks: [],
        ...(workerProfile ? { workerProfile } : {}),
      };
    }

    if (
      preflightCache &&
      preflightCache.rootPath === selectedPath &&
      Date.now() - preflightCache.at < PREFLIGHT_TTL_MS
    ) {
      return preflightCache.result;
    }

    const [
      hasSupportedTrackerRemote,
      isTrackerAuthenticated,
      targetBranchExists,
      installedSkills,
      workerProfile,
    ] = await Promise.all([
      bound.environment.hasSupportedTrackerRemote(),
      bound.environment.isTrackerAuthenticated(),
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
        id: "tracker-remote",
        ok: hasSupportedTrackerRemote,
        guidance: hasSupportedTrackerRemote
          ? "A supported tracker remote is configured."
          : "No supported tracker is configured for this Workflow root. Use a GitHub origin, or configure Forgejo in .pi/matt-auto/forge.json. Matt Auto does not create repositories or remotes.",
      },
      {
        id: "tracker-auth",
        ok: isTrackerAuthenticated,
        guidance: isTrackerAuthenticated
          ? "The selected tracker identity is authenticated."
          : "The selected tracker identity is not authenticated. Authenticate gh for GitHub, or set the configured Forgejo token environment variable/tokenFile, then retry Workflow preflight.",
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

    if (typeof bound.tracker.inspectProtectedBranchAutomation === "function") {
      const automationChecks = await collectProtectedBranchAutomationChecks(
        bound,
        targetBranch,
      );
      checks.push(...automationChecks);
    }

    const result: PreflightResult = {
      ok: checks.every((check) => check.ok),
      targetBranch,
      checks,
    };
    if (workerProfile) {
      result.workerProfile = workerProfile;
    }
    preflightCache = {
      result,
      at: Date.now(),
      rootPath: selectedPath ?? ports.startPath,
    };
    return result;
  }


  async function listResumableActiveWorkflows(): Promise<readonly ActiveWorkflow[]> {
    const bound = await requireScoped();
    const context = await resolveCoordinationRoutingContext(bound);
    if (!context.supported) {
      const targetBranch = await resolveTargetBranch(
        bound.preferences,
        bound.environment,
      );
      const active = await bound.tracker.findActiveWorkflow(targetBranch);
      return active ? [active] : [];
    }
    if (!context.ok) {
      throw new Error(context.reason);
    }
    try {
      return await bound.tracker.findActiveWorkflows(context.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not list Active workflows for take-over: ${message}`,
      );
    }
  }

  function getNextActionsDiagnostic(): NextActionsDiagnostic | undefined {
    return lastNextActionsDiagnostic
      ? { ...lastNextActionsDiagnostic }
      : undefined;
  }

  function workflowRoutingActions(route: WorkflowHomeRoute): NextAction[] {
    if (route.kind === "selection-required") {
      const resume = route.candidates.map((candidate) => ({
        id: resumeWorkflowActionId(candidate.workflowId),
        label: `Resume Workflow #${candidate.workflowId}`,
        description: [
          candidate.title ? candidate.title : `Active workflow at ${candidate.stage}`,
          "Bind this checkout explicitly and acquire its Workflow coordinator lease.",
          route.staleBinding
            ? `Previous binding #${route.staleBinding.workflowId} is no longer Active.`
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join(" "),
      }));
      const actions: NextAction[] = [
        ...resume,
        {
          id: START_NEW_INDEPENDENT_WORKFLOW_ACTION.id,
          label: START_NEW_INDEPENDENT_WORKFLOW_ACTION.label,
          description: START_NEW_INDEPENDENT_WORKFLOW_ACTION.description,
        },
      ];
      if (
        route.candidates.length === 0 &&
        lastCompletedWorkflow &&
        targetRefFromBranch(lastCompletedWorkflow.targetBranch) ===
          route.target.targetRef
      ) {
        actions.push({
          id: START_FOLLOW_UP_ACTION.id,
          label: START_FOLLOW_UP_ACTION.label,
          description: `${START_FOLLOW_UP_ACTION.description} References completed Workflow #${lastCompletedWorkflow.workflowId}.`,
        });
      }
      return actions;
    }
    if (route.kind === "lease-held") {
      return [
        {
          id: resumeWorkflowActionId(route.active.workflowId),
          label: `Resume Workflow #${route.active.workflowId}`,
          description: `Workflow coordinator lease is held${route.holderId ? ` by ${route.holderId}` : " by another Workflow home"}. Retry only after that home releases or the lease expires.`,
        },
      ];
    }
    return [];
  }

  async function nextActions(): Promise<NextAction[]> {
    lastNextActionsDiagnostic = undefined;
    // Action discovery is state/routing only. Each action validates the
    // remote, skill, worker, and delivery requirements it actually needs.
    const bound = await requireScoped();
    const route = await loadWorkflowHomeRoute(bound);
    if (
      route.kind === "selection-required" ||
      route.kind === "lease-held"
    ) {
      const actions = workflowRoutingActions(route);
      lastNextActionsDiagnostic = {
        routeKind: route.kind,
        ...(route.kind === "lease-held"
          ? {
              workflowId: route.active.workflowId,
              reason: route.holderId
                ? `Workflow coordinator lease held by ${route.holderId}.`
                : "Workflow coordinator lease held by another Workflow home.",
            }
          : {
              reason:
                route.candidates.length === 0
                  ? "No Active workflow is bound to this checkout; choose Start new independent workflow or create a Follow-up."
                  : `Choose Resume among ${route.candidates.length} Active workflow(s) or Start new independent workflow.`,
            }),
      };
      return actions;
    }
    if (route.kind === "unavailable") {
      lastNextActionsDiagnostic = {
        routeKind: "unavailable",
        reason: route.reason,
      };
      return [];
    }
    const active = route.active;

    if (!active) {
      const actions: NextAction[] = [
        {
          id: CREATE_SPEC_ACTION.id,
          label: CREATE_SPEC_ACTION.label,
          description: CREATE_SPEC_ACTION.description,
        },
      ];
      const targetBranch = await resolveTargetBranch(bound.preferences, bound.environment);
      if (
        lastCompletedWorkflow &&
        lastCompletedWorkflow.targetBranch === targetBranch
      ) {
        actions.push({
          id: START_FOLLOW_UP_ACTION.id,
          label: START_FOLLOW_UP_ACTION.label,
          description: `${START_FOLLOW_UP_ACTION.description} References completed Workflow #${lastCompletedWorkflow.workflowId}.`,
        });
      }
      lastNextActionsDiagnostic = {
        routeKind: route.kind,
        reason: "No Active workflow; startup actions are available.",
      };
      return actions;
    }

    lastNextActionsDiagnostic = {
      routeKind: route.kind,
      workflowId: active.workflowId,
    };

    await recoverCompletedWorkerTelemetryFromTranscripts(bound, active);

    if (active.stage === "spec-published") {
      return [
        {
          id: CREATE_TICKETS_ACTION.id,
          label: CREATE_TICKETS_ACTION.label,
          description: CREATE_TICKETS_ACTION.description,
        },
      ];
    }

    if (active.stage === "merged") {
      return [
        {
          id: CLEANUP_WORKFLOW_ACTION.id,
          label: CLEANUP_WORKFLOW_ACTION.label,
          description: CLEANUP_WORKFLOW_ACTION.description,
        },
      ];
    }

    if (isTicketWorkStage(active.stage)) {
      // Conflict resolution is singular and owns the operator surface while alive.
      if (activeConflictWorker) {
        return [];
      }

      // New /matt-auto run loses in-memory disposition/integration state.
      // Rebuild from transcripts so we Retry Integration / Auto-Close instead
      // of launching another Implement attempt for the same ticket.
      if (!pendingDisposition && !pendingIntegration) {
        await recoverPendingDispositionFromTranscripts(bound, active);
      }

      // P1: disposition is offered even while other Implementation workers run.
      if (pendingDisposition) {
        return [
          {
            id: dispositionActionId(pendingDisposition.ticketNumber),
            label: `Disposition #${pendingDisposition.ticketNumber}`,
            description:
              pendingDisposition.summary ??
              "Close / Leave open / Investigate after the Implementation worker Stage result.",
          },
        ];
      }

      // Fail-closed Integration unit retry (one ticket at a time).
      // While a unit is actively running, do not re-offer Retry (avoids the
      // "already in progress" auto-advance race after conflict resolution).
      if (pendingIntegration && !integrationInProgress && !activeConflictWorker) {
        return [
          {
            id: integrateTicketActionId(pendingIntegration.ticketNumber),
            label: `Retry Integration #${pendingIntegration.ticketNumber}`,
            description:
              pendingIntegration.lastFailure ??
              "Retry the serialized Integration unit (merge, Local verification, coordinator push).",
          },
        ];
      }
      if (pendingIntegration && (integrationInProgress || activeConflictWorker)) {
        // Empty next list → wait surface owns progress until the unit settles.
        return [];
      }

      // Target-branch refresh owns the operator surface while the lease is held
      // or a Target-refresh Conflict resolution worker is active.
      if (pendingTargetRefresh && !targetRefreshInProgress && !activeConflictWorker) {
        return [
          {
            id: REFRESH_FROM_TARGET_ACTION.id,
            label: `Retry ${REFRESH_FROM_TARGET_ACTION.label}`,
            description:
              pendingTargetRefresh.lastFailure ??
              REFRESH_FROM_TARGET_ACTION.description,
          },
        ];
      }
      if (pendingTargetRefresh && (targetRefreshInProgress || activeConflictWorker)) {
        return [];
      }

      // Legacy workflows retain local N/running accounting. Coordination-aware
      // workflows preview the shared remote plan instead; conditional slot
      // acquisition in startImplementation remains the authoritative fence.
      const localCapacity = active.coordination
        ? undefined
        : await freeImplementationSlots(bound);
      const slots = localCapacity?.slots ?? 1;
      const runningWorkers = hasRunningImplementationWorkers();
      let repositoryLaunchableTicketNumbers: ReadonlySet<number> | undefined;
      if (active.coordination) {
        const preview = await previewRepositoryWorkerSlots(bound, active);
        repositoryLaunchableTicketNumbers = new Set(
          preview.ok
            ? preview.plan.claimable
                .filter((claim) => claim.workflowId === active.workflowId)
                .map((claim) => claim.ticketNumber)
            : [],
        );
      }

      if (!active.coordination && slots === 0 && runningWorkers) {
        // No free local slots while legacy workers run — wait surface, no overflow implements.
        return [];
      }

      const actions: NextAction[] = [];
      // CI / PR / cleanup only when no Implementation workers are running so
      // slot filling and wait semantics stay simple under concurrency.
      if (!runningWorkers && pendingCiRecovery) {
        const n = pendingCiRecovery.ticketNumber;
        const detail =
          pendingCiRecovery.summary ??
          "CI gate failed. Inspect the run, retry the check, or leave the ticket open.";
        actions.push(
          {
            id: ciRecoveryActionId(n, "inspect"),
            label: `Inspect CI #${n}`,
            description: detail,
          },
          {
            id: ciRecoveryActionId(n, "retry"),
            label: `Retry CI #${n}`,
            description:
              "Re-push the Integration branch if needed and re-run the on-demand CI gate check once.",
          },
          {
            id: ciRecoveryActionId(n, "leave-open"),
            label: `Leave open #${n}`,
            description:
              "Dismiss CI recovery and leave the tracker ticket open. Check CI remains available later.",
          },
        );
      }

      const progress = await loadTicketProgress(bound, active, {
        force: true,
      });
      if (!progress) {
        return actions;
      }

      if (!runningWorkers) {
        for (const ticket of progress.awaitingCi) {
          if (pendingCiRecovery?.ticketNumber === ticket.number) continue;
          actions.push({
            id: checkCiActionId(ticket.number),
            label: `Check CI #${ticket.number}`,
            description: `${ticket.title}. On-demand CI gate check — pending returns control immediately; green closes the ticket; red offers recovery.`,
          });
        }
      }

      // Offer Implement only when local legacy capacity or the current shared
      // repository plan can allocate that exact ready ticket (P1 already gated).
      const canOfferImplementation = active.coordination
        ? (repositoryLaunchableTicketNumbers?.size ?? 0) > 0
        : slots > 0;
      if (canOfferImplementation) {
        const now = Date.now();
        const launchable = progress.ready.filter((ticket) => {
          if (
            active.coordination &&
            !repositoryLaunchableTicketNumbers?.has(ticket.number)
          ) {
            return false;
          }
          if (findRunningWorkerForTicket(ticket.number)) return false;
          const cooled = implementationRecoveryCooldown.get(ticket.number);
          if (cooled === undefined) return true;
          if (now - cooled.sinceMs >= IMPLEMENTATION_RECOVERY_COOLDOWN_MS) {
            implementationRecoveryCooldown.delete(ticket.number);
            return true;
          }
          return false;
        });
        // Stable ticket-number order is already how progress.ready is sorted.
        actions.push(...launchable.map(formatImplementAction));

        // Pre-merge Rework for closed integrated tickets (same local P1 rules).
        // Coordination-aware rework is offered after reopening creates a fresh
        // ready ticket; its remote slot cannot be predicted while still closed.
        if (!active.coordination && (!active.workflowPr || active.stage === "pr-opened")) {
          const closedIntegrated = (active.integratedTickets ?? []).filter(
            (t) =>
              !progress.ready.some((r) => r.number === t.number) &&
              !progress.awaitingCi.some((r) => r.number === t.number) &&
              !progress.blocked.some((r) => r.number === t.number),
          );
          if (closedIntegrated.length > 0) {
            const closedTickets = await bound.tracker.listTickets(
              closedIntegrated.map((t) => t.number),
            );
            for (const ticket of closedTickets) {
              if (ticket.state !== "CLOSED") continue;
              if (findRunningWorkerForTicket(ticket.number)) continue;
              actions.push({
                id: reworkTicketActionId(ticket.number),
                label: `Rework #${ticket.number}`,
                description: `${ticket.title}. Pre-merge Rework attempt: reopen the ticket and create a fresh numbered Implementation workspace without reusing the completed one.`,
              });
            }
          }
        }
      } else if (runningWorkers) {
        // No locally/fairly allocatable slot and workers still run — wait.
        return [];
      }

      if (!runningWorkers && allTicketsComplete(progress)) {
        const integratedCount = active.integratedTickets?.length ?? 0;
        const allIntegrated =
          integratedCount >= progress.total &&
          (active.tickets ?? []).every((n) =>
            (active.integratedTickets ?? []).some((t) => t.number === n),
          );
        if (allIntegrated && active.integrationBranch) {
          if (!active.workflowPr) {
            actions.unshift({
              id: OPEN_WORKFLOW_PR_ACTION.id,
              label: OPEN_WORKFLOW_PR_ACTION.label,
              description: `${OPEN_WORKFLOW_PR_ACTION.description} Target branch: ${active.targetBranch}.`,
            });
          } else if (active.stage === "pr-opened") {
            if (active.coordination) {
              const candidate = active.coordination.queueCandidate;
              const missingValidatedTarget =
                !active.coordination.prFreshness?.validatedTargetSha;
              // Refresh must be available as soon as a Workflow PR is open when
              // Target freshness is missing — do not hide it behind merge-ready
              // (which never arrives if PR checks never start).
              const refreshable =
                missingValidatedTarget ||
                candidate?.state === "merge-ready" ||
                candidate?.state === "refreshing" ||
                candidate?.state === "awaiting-pr-checks" ||
                pendingTargetRefresh !== undefined;
              // Offer Merge only when a validated Target SHA is on record so
              // Merge is never the sole Next action that always fail-closes.
              const mergeable = !missingValidatedTarget;
              // unshift order: last unshift is first in the list.
              if (mergeable) {
                actions.unshift({
                  id: MERGE_WORKFLOW_PR_ACTION.id,
                  label: MERGE_WORKFLOW_PR_ACTION.label,
                  description: `${MERGE_WORKFLOW_PR_ACTION.description} PR #${active.workflowPr.number} → ${active.workflowPr.baseBranch}.`,
                });
              }
              if (refreshable && !targetRefreshInProgress) {
                actions.unshift({
                  id: REFRESH_FROM_TARGET_ACTION.id,
                  label: REFRESH_FROM_TARGET_ACTION.label,
                  description: `${REFRESH_FROM_TARGET_ACTION.description} PR #${active.workflowPr.number} → ${active.workflowPr.baseBranch}.`,
                });
              }
            } else {
              actions.unshift({
                id: MERGE_WORKFLOW_PR_ACTION.id,
                label: MERGE_WORKFLOW_PR_ACTION.label,
                description: `${MERGE_WORKFLOW_PR_ACTION.description} PR #${active.workflowPr.number} → ${active.workflowPr.baseBranch}.`,
              });
            }
          }
        }
      }

      // Ticket progress is informational; omit while workers run so the
      // pipeline auto-picker stays on implement fills / wait.
      if (!runningWorkers) {
        actions.push(formatTicketProgressAction(progress));
      } else if (actions.length === 0) {
        // Running workers, free slots, but no launchable ready ticket left.
        lastNextActionsDiagnostic = {
          routeKind: route.kind,
          workflowId: active.workflowId,
          readyCount: progress.ready.length,
          openCount: progress.open,
          reason:
            "Implementation workers are running; no additional ready ticket can launch yet.",
        };
        return [];
      }
      lastNextActionsDiagnostic = {
        routeKind: route.kind,
        workflowId: active.workflowId,
        readyCount: progress.ready.length,
        openCount: progress.open,
        ...(actions.every(
          (action) =>
            action.id === TICKET_PROGRESS_ACTION.id || isReworkActionId(action.id),
        )
          ? {
              reason:
                "No auto-advanceable Next action (ready frontier empty or only Rework/ticket-progress remain).",
            }
          : {}),
      };
      return actions;
    }

    lastNextActionsDiagnostic = {
      routeKind: route.kind,
      workflowId: active.workflowId,
      reason: "No Next actions for this Active workflow stage.",
    };
    return [];
  }

  function isReworkActionId(actionId: string): boolean {
    return actionId.startsWith(REWORK_TICKET_ACTION_PREFIX);
  }

  async function runNextAction(actionId: string): Promise<StageResult> {
    if (actionId === CREATE_SPEC_ACTION.id) {
      return startCreateSpec();
    }

    if (actionId === START_NEW_INDEPENDENT_WORKFLOW_ACTION.id) {
      return startCreateSpec({ independent: true });
    }

    const resumeWorkflowId = parseResumeWorkflowActionId(actionId);
    if (resumeWorkflowId !== undefined) {
      return resumeWorkflow(resumeWorkflowId);
    }

    if (actionId === CREATE_TICKETS_ACTION.id) {
      return startCreateTickets();
    }

    if (actionId === TICKET_PROGRESS_ACTION.id) {
      return showTicketProgress();
    }

    const implementTicket = parseImplementTicketActionId(actionId);
    if (implementTicket !== undefined) {
      return startImplementation(implementTicket);
    }

    const dispositionTicket = parseDispositionActionId(actionId);
    if (dispositionTicket !== undefined) {
      return presentPendingDisposition(dispositionTicket);
    }

    const integrateTicket = parseIntegrateTicketActionId(actionId);
    if (integrateTicket !== undefined) {
      return retryIntegration(integrateTicket);
    }

    const checkCiTicket = parseCheckCiActionId(actionId);
    if (checkCiTicket !== undefined) {
      return runCiGateCheck(checkCiTicket, { rePush: false });
    }

    const ciRecovery = parseCiRecoveryActionId(actionId);
    if (ciRecovery !== undefined) {
      return runCiRecovery(ciRecovery.ticketNumber, ciRecovery.decision);
    }

    if (actionId === OPEN_WORKFLOW_PR_ACTION.id) {
      return openWorkflowPr();
    }

    if (actionId === REFRESH_FROM_TARGET_ACTION.id) {
      return runTargetRefresh();
    }

    if (actionId === MERGE_WORKFLOW_PR_ACTION.id) {
      return mergeWorkflowPr();
    }

    if (actionId === CLEANUP_WORKFLOW_ACTION.id) {
      return cleanupWorkflow();
    }

    if (actionId === START_FOLLOW_UP_ACTION.id) {
      return startFollowUpWorkflow();
    }

    const reworkTicket = parseReworkTicketActionId(actionId);
    if (reworkTicket !== undefined) {
      return startRework(reworkTicket);
    }

    return {
      status: "failed",
      stage: "create-spec",
      reason: `Unknown Next action "${actionId}".`,
    };
  }

  async function presentPendingDisposition(
    ticketNumber: number,
  ): Promise<StageResult> {
    if (!pendingDisposition || pendingDisposition.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "implement",
        reason: `No pending Implementation disposition for #${ticketNumber}.`,
        ticketNumber,
      };
    }

    const current = pendingDisposition;
    const result: StageResult = {
      status: "needs-disposition",
      stage: "implement",
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
      workerId: current.workerId,
      dispositionOptions: [...IMPLEMENTATION_DISPOSITION_OPTIONS],
    };
    if (current.summary) {
      result.summary = current.summary;
    }
    return result;
  }

  async function resumeWorkflow(workflowId: number): Promise<StageResult> {
    const bound = await requireScoped();
    const context = await resolveCoordinationRoutingContext(bound);
    if (!context.supported) {
      return {
        status: "failed",
        stage: "workflow-routing",
        reason:
          "Explicit Workflow-home resume is unavailable while this root is using legacy workflow routing.",
        workflowId,
      };
    }
    if (!context.ok) {
      return {
        status: "failed",
        stage: "workflow-routing",
        reason: context.reason,
        workflowId,
      };
    }

    // Prefer single-issue discovery for explicit resume. Full open-issue
    // pagination is expensive and fails closed under GitHub rate limits with a
    // generic message (Workflow #53 take-over while listing all open issues).
    const targetBranch = targetBranchFromRef(context.target.targetRef);
    let active: ActiveWorkflow | undefined;
    try {
      if (targetBranch) {
        active = await bound.tracker.findActiveWorkflow(
          targetBranch,
          workflowId,
        );
      }
      if (!active) {
        const candidates = await bound.tracker.findActiveWorkflows(
          context.target,
        );
        active = candidates.find(
          (candidate) => candidate.workflowId === workflowId,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-routing",
        reason: `Could not discover Workflow #${workflowId} for resume: ${message}`,
        workflowId,
      };
    }
    if (!active) {
      return {
        status: "failed",
        stage: "workflow-routing",
        reason: `Workflow #${workflowId} is not an Active workflow for this canonical Target. It was not bound.`,
        workflowId,
      };
    }

    if (!active.coordination) {
      // Existing v1 workflows retain their single-workflow path. Persist only
      // the legacy routing hint rather than pretending their manifest has a
      // remote coordinator lease it cannot validate.
      const local = await ensureWorkflowHomeLock(bound);
      if (!local.ok) {
        return {
          status: "failed",
          stage: "workflow-routing",
          reason: local.reason,
          workflowId,
        };
      }
      await bound.preferences.setActiveWorkflowId(active.targetBranch, workflowId);
      invalidatePanelCaches();
      return {
        status: "completed",
        stage: "workflow-routing",
        workflowId,
        targetBranch: active.targetBranch,
      };
    }

    const lease = await ensureWorkflowCoordinatorLease(
      bound,
      context.target,
      workflowId,
    );
    if (!lease.ok) {
      return {
        status: "failed",
        stage: "workflow-routing",
        reason: lease.reason,
        workflowId,
      };
    }
    try {
      await persistWorkflowHomeBinding(bound, context.target, workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await releaseHeldWorkflowCoordinatorLease(bound);
      return {
        status: "failed",
        stage: "workflow-routing",
        reason: `Workflow #${workflowId} acquired its coordinator lease but could not persist this checkout's binding: ${message}`,
        workflowId,
      };
    }
    invalidatePanelCaches();
    return {
      status: "completed",
      stage: "workflow-routing",
      workflowId,
      targetBranch: active.targetBranch,
    };
  }

  async function startCreateSpec(
    options: { independent?: boolean } = {},
  ): Promise<StageResult> {
    const bound = await requireScoped();
    // Create-spec planning is local. Publish validates its remote prerequisites
    // after the operator has approved a reviewable draft.
    const route = await loadWorkflowHomeRoute(bound, { force: true });
    if (route.kind === "legacy" || route.kind === "bound") {
      const active = route.active;
      if (active) {
        return {
          status: "failed",
          stage: "create-spec",
          reason: `An Active workflow already exists for Target branch "${active.targetBranch}" (Workflow ID #${active.workflowId}). Create-spec is unavailable until that workflow completes.`,
        };
      }
    }
    if (route.kind === "lease-held") {
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Workflow #${route.active.workflowId} remains bound to this checkout, but its coordinator lease is held by another Workflow home. Resume it explicitly after that lease is released.`,
        workflowId: route.active.workflowId,
      };
    }
    if (route.kind === "unavailable") {
      return {
        status: "failed",
        stage: "create-spec",
        reason: route.reason,
      };
    }
    if (route.kind === "selection-required" && !options.independent) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "This checkout has no valid Workflow-home binding. Choose Resume Workflow or Start new independent workflow explicitly.",
      };
    }
    // A fresh legacy home and an explicit coordinated Start-new choice both
    // acquire the same local checkout guard before Planning begins.
    const local = await ensureWorkflowHomeLock(bound);
    if (!local.ok) {
      return {
        status: "failed",
        stage: "create-spec",
        reason: local.reason,
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

  async function startCreateTickets(): Promise<StageResult> {
    const bound = await requireScoped();
    // to-tickets validates its own installed skill; remote writes happen only
    // after the resulting draft is explicitly published.
    const active = await loadActiveWorkflow(bound);
    if (!active) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "No Active workflow exists. Publish Create-spec before running Create-tickets.",
      };
    }

    if (active.stage !== "spec-published") {
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Create-tickets is unavailable while the Active workflow is in stage "${active.stage}".`,
      };
    }

    if (pending) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "A Stage confirmation is already pending. Choose Publish, Revise, or Cancel before starting Create-tickets again.",
      };
    }

    // Planning stage: invoke installed to-tickets in Workflow home; never publish here.
    return invokeCreateTickets(bound, active.workflowId, active.title);
  }

  async function showTicketProgress(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "tickets-published") {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Ticket progress is available only after Create-tickets has been published for the Active workflow.",
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason: "Could not compute ticket progress from tracker state.",
      };
    }

    const completed: StageResult = {
      status: "completed",
      stage: "create-tickets",
      workflowId: active.workflowId,
      ticketProgress: progress,
    };
    if (active.tickets) {
      completed.tickets = [...active.tickets];
    }
    return completed;
  }

  async function confirmStage(
    decision: StageConfirmationDecision,
  ): Promise<StageResult> {
    if (!pending) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "No pending Stage confirmation. Run a Planning stage first and wait for a reviewable draft.",
      };
    }

    if (pending.stage === "create-spec") {
      return confirmCreateSpec(decision, pending);
    }

    return confirmCreateTickets(decision, pending);
  }

  async function confirmCreateSpec(
    decision: StageConfirmationDecision,
    current: PendingCreateSpec,
  ): Promise<StageResult> {
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
    const draft = current.draft;
    const targetBranch = await resolveTargetBranch(bound.preferences, bound.environment);
    // Target identity becomes durable in the new manifest, so validate it at
    // publish time rather than before the local to-spec planning stage.
    if (!(await bound.environment.targetBranchExists(targetBranch))) {
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Cannot publish Create-spec: Target branch "${targetBranch}" was not found locally or on a remote. Create or fetch it, or configure a different Target branch.`,
      };
    }
    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "Cannot publish Create-spec without a Worker profile. Configure one and retry Stage confirmation Publish.",
      };
    }

    const routing = await resolveCoordinationRoutingContext(bound);
    if (routing.supported && !routing.ok) {
      return {
        status: "failed",
        stage: "create-spec",
        reason: routing.reason,
      };
    }
    if (routing.supported) {
      const local = await ensureWorkflowHomeLock(bound);
      if (!local.ok) {
        return { status: "failed", stage: "create-spec", reason: local.reason };
      }
    }

    // A newly-created issue has no Workflow ID until GitHub returns it, so its
    // remote coordinator lease is acquired immediately afterward and before
    // the first managed manifest write.
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
        reason: `Failed to create the tracker spec issue: ${message}`,
      };
    }

    let coordinatorLease: WorkflowCoordinatorLease | undefined;
    if (routing.supported && routing.ok) {
      const lease = await ensureWorkflowCoordinatorLease(
        bound,
        routing.target,
        issueNumber,
      );
      if (!lease.ok) {
        pending = undefined;
        return {
          status: "failed",
          stage: "create-spec",
          workflowId: issueNumber,
          reason: `Spec issue #${issueNumber} was created, but its Workflow coordinator lease could not be acquired: ${lease.reason}`,
        };
      }
      coordinatorLease = lease.lease;
    }

    const manifest: WorkflowManifest =
      routing.supported && routing.ok && coordinatorLease
        ? {
            schema: WORKFLOW_MANIFEST_SCHEMA,
            version: 2,
            workflowId: issueNumber,
            targetBranch,
            stage: "spec-published",
            workerProfile: workerProfile.profile,
            coordination: {
              target: copyCanonicalTarget(routing.target),
              observedLeaseGenerations: {
                workflowCoordinator: coordinatorLease.generation,
              },
            },
          }
        : {
            schema: WORKFLOW_MANIFEST_SCHEMA,
            version: 1,
            workflowId: issueNumber,
            targetBranch,
            stage: "spec-published",
            workerProfile: workerProfile.profile,
          };

    try {
      await bound.tracker.writeWorkflowManifest(issueNumber, manifest);
      if (routing.supported && routing.ok) {
        await persistWorkflowHomeBinding(bound, routing.target, issueNumber);
      } else {
        // Retain the v1 local pointer only for legacy manifests.
        await bound.preferences.setActiveWorkflowId(targetBranch, issueNumber);
      }
      invalidatePanelCaches();
    } catch (error) {
      // Issue already exists remotely — drop the session pending draft so a retry
      // cannot create a second spec issue for the same Stage confirmation.
      pending = undefined;
      if (routing.supported) {
        await releaseHeldWorkflowCoordinatorLease(bound);
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Spec issue #${issueNumber} was created, but writing the Workflow manifest or local binding failed: ${message}. Inspect issue #${issueNumber} and recover it explicitly before continuing.`,
      };
    }

    pending = undefined;
    return {
      status: "completed",
      stage: "create-spec",
      workflowId: issueNumber,
    };
  }

  async function confirmCreateTickets(
    decision: StageConfirmationDecision,
    current: PendingCreateTickets,
  ): Promise<StageResult> {
    if (decision === "cancel") {
      pending = undefined;
      return {
        status: "cancelled",
        stage: "create-tickets",
      };
    }

    const bound = await requireScoped();

    if (decision === "revise") {
      pending = undefined;
      return invokeCreateTickets(
        bound,
        current.workflowId,
        current.workflowTitle,
      );
    }

    // decision === "publish"
    // Log before any tracker/lease I/O so hangs after auto-publish are localizable.
    clog("info", "create-tickets:publish-begin", {
      workflowId: current.workflowId,
      ticketCount: current.draft.tickets.length,
    });
    createTicketsPublishInProgress = true;
    try {
    let active: ActiveWorkflow | undefined;
    try {
      active = await loadActiveWorkflow(bound);
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      clog("warn", "create-tickets:publish-load-active-failed", {
        workflowId: current.workflowId,
        reason: message,
      });
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Could not load Active workflow before Create-tickets publish: ${message}`,
        workflowId: current.workflowId,
      };
    }
    if (!active || active.workflowId !== current.workflowId) {
      pending = undefined;
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Active workflow changed before Create-tickets publish. Re-run Create-tickets from Next actions.",
      };
    }
    if (active.stage !== "spec-published") {
      pending = undefined;
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Cannot publish Create-tickets while the Active workflow is in stage "${active.stage}".`,
      };
    }

    // Capture after guards so nested refreshPublishAuthority keeps a definite ActiveWorkflow.
    const publishWorkflow = active;

    const initialAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      publishWorkflow,
    );
    if (!initialAuthority.ok) {
      pending = undefined;
      clog("warn", "create-tickets:publish-lease-failed", {
        workflowId: publishWorkflow.workflowId,
        reason: initialAuthority.reason,
      });
      return {
        status: "failed",
        stage: "create-tickets",
        reason: initialAuthority.reason,
        workflowId: publishWorkflow.workflowId,
      };
    }

    const ordered = topologicalOrder(current.draft.tickets);
    const localToNumber = new Map<string, number>();
    const localToTitle = new Map(
      current.draft.tickets.map((t) => [t.localId, t.title]),
    );
    const createdNumbers: number[] = [];
    let lastAuthorityAtMs = Date.now();

    /**
     * Hold one coordinator lease for the publish batch. Re-ensure only on the
     * heartbeat interval (or when the in-memory hold was lost) — not before
     * every createIssue / sub-issue / blockedBy call.
     */
    async function refreshPublishAuthority(force = false): Promise<void> {
      const due =
        force ||
        Date.now() - lastAuthorityAtMs >=
          DEFAULT_COORDINATION_LEASE_HEARTBEAT_INTERVAL_MS;
      if (!due) {
        await heartbeatHeldWorkflowCoordinatorLease(bound);
        // Heartbeat may clear a lost remote lease without throwing.
        if (
          publishWorkflow.coordination &&
          !heldWorkflowCoordinatorLease
        ) {
          const recovered = await ensureActiveWorkflowCoordinatorLease(
            bound,
            publishWorkflow,
          );
          if (!recovered.ok) throw new Error(recovered.reason);
          lastAuthorityAtMs = Date.now();
        }
        return;
      }
      const authority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        publishWorkflow,
      );
      if (!authority.ok) throw new Error(authority.reason);
      lastAuthorityAtMs = Date.now();
    }

    clog("info", "create-tickets:publish-start", {
      workflowId: publishWorkflow.workflowId,
      ticketCount: ordered.length,
    });

    try {
      for (let index = 0; index < ordered.length; index += 1) {
        const ticket = ordered[index]!;
        await refreshPublishAuthority(index === 0);

        const blockers = ticket.blockedBy.map((localId) => {
          const number = localToNumber.get(localId);
          if (number === undefined) {
            throw new Error(
              `Missing published issue for blocker localId "${localId}".`,
            );
          }
          return {
            number,
            title: localToTitle.get(localId) ?? `#${number}`,
          };
        });

        const body = formatPublishedTicketBody(
          ticket,
          current.workflowId,
          current.workflowTitle ?? active.title,
          blockers,
        );

        clog("info", "create-tickets:publish-ticket", {
          workflowId: active.workflowId,
          index: index + 1,
          total: ordered.length,
          localId: ticket.localId,
          title: ticket.title,
        });

        const created = await bound.tracker.createIssue({
          title: ticket.title,
          body,
          labels: [TICKET_ISSUE_LABEL],
        });
        localToNumber.set(ticket.localId, created.number);
        createdNumbers.push(created.number);

        await bound.tracker.addSubIssue(current.workflowId, created.number);

        for (const blocker of blockers) {
          await bound.tracker.addBlockedBy(created.number, blocker.number);
        }

        clog("info", "create-tickets:publish-ticket-linked", {
          workflowId: active.workflowId,
          issueNumber: created.number,
          blockers: blockers.map((b) => b.number),
        });
      }
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const created =
        createdNumbers.length > 0
          ? ` Created ticket issues: ${createdNumbers.map((n) => `#${n}`).join(", ")}.`
          : "";
      clog("warn", "create-tickets:publish-failed", {
        workflowId: active.workflowId,
        createdNumbers,
        reason: message,
      });
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Failed while publishing Create-tickets:${created} ${message}`.trim(),
      };
    }

    const manifest = manifestFromActive(active, {
      stage: "tickets-published",
      tickets: createdNumbers,
    });

    try {
      await refreshPublishAuthority(true);
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      clog("warn", "create-tickets:publish-lease-failed", {
        workflowId: active.workflowId,
        phase: "manifest",
        reason: message,
      });
      return {
        status: "failed",
        stage: "create-tickets",
        reason: message,
        workflowId: active.workflowId,
      };
    }

    const finalAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!finalAuthority.ok) {
      pending = undefined;
      return {
        status: "failed",
        stage: "create-tickets",
        reason: finalAuthority.reason,
        workflowId: active.workflowId,
      };
    }

    clog("info", "create-tickets:publish-manifest", {
      workflowId: active.workflowId,
      tickets: createdNumbers,
    });

    try {
      await bound.tracker.writeWorkflowManifest(
        current.workflowId,
        manifestWithCoordinatorLeaseGeneration(manifest, finalAuthority.lease),
      );
      invalidatePanelCaches();
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      clog("warn", "create-tickets:publish-manifest-failed", {
        workflowId: active.workflowId,
        createdNumbers,
        reason: message,
      });
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Ticket issues ${createdNumbers.map((n) => `#${n}`).join(", ")} were created, but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${current.workflowId} before continuing.`,
      };
    }

    pending = undefined;

    // Re-read ticket state from GitHub for the frontier snapshot.
    const listed = await bound.tracker.listTickets(createdNumbers);
    const progress = computeTicketProgress(current.workflowId, listed);

    clog("info", "create-tickets:publish-ok", {
      workflowId: current.workflowId,
      tickets: createdNumbers,
    });

    return {
      status: "completed",
      stage: "create-tickets",
      workflowId: current.workflowId,
      tickets: createdNumbers,
      ticketProgress: progress,
    };
    } finally {
      createTicketsPublishInProgress = false;
    }
  }

  async function getActiveWorkflow(): Promise<ActiveWorkflow | undefined> {
    const bound = await requireScoped();
    return loadActiveWorkflow(bound);
  }

  async function getTicketProgress(): Promise<
    TicketProgressSummary | undefined
  > {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound, { force: true });
    if (!active) return undefined;
    // Public progress reads should reflect latest GitHub ticket state.
    return loadTicketProgress(bound, active, { force: true });
  }

  async function startImplementation(ticketNumber: number): Promise<StageResult> {
    const bound = await requireScoped();
    // Implementation checks its frontier, lease, Worker profile, and implement
    // skill below; final-delivery policy is irrelevant to worker launch.
    if (pending) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "A Stage confirmation is already pending. Finish Create-spec or Create-tickets before launching an Implementation worker.",
        ticketNumber,
      };
    }

    const alreadyRunning = findRunningWorkerForTicket(ticketNumber);
    if (alreadyRunning) {
      return {
        status: "failed",
        stage: "implement",
        reason: `An Implementation worker is already running for #${alreadyRunning.ticketNumber} (r${alreadyRunning.attempt}).`,
        ticketNumber,
      };
    }

    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Implementation workers require an Active workflow with published tickets (pre-merge).",
        ticketNumber,
      };
    }

    const initialAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!initialAuthority.ok) {
      return {
        status: "failed",
        stage: "implement",
        reason: initialAuthority.reason,
        ticketNumber,
        workflowId: active.workflowId,
      };
    }

    const progress = await loadTicketProgress(bound, active);
    const ready = progress?.ready.find((t) => t.number === ticketNumber);
    if (!ready) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Ticket #${ticketNumber} is not on the ready frontier (open with no open blockers).`,
        ticketNumber,
      };
    }

    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Cannot launch an Implementation worker without a Worker profile.",
        ticketNumber,
      };
    }

    const latest = await bound.workspace.latestAttempt(
      active.workflowId,
      ticketNumber,
    );
    const targetBranch = await resolveTargetBranch(bound.preferences, bound.environment);
    // Dependents branch from the Integration branch after successful units.
    const baseRef = active.integrationBranch ?? targetBranch;
    const rootPath = selectedPath ?? ports.startPath;

    // Prefer the latest unintegrated Implementation attempt over blind rN+1:
    // completed → disposition; incomplete with commits → same branch relaunch;
    // empty/failed → fresh attempt. Never claims worker-dialogue continuation.
    type AttemptPlan =
      | {
          kind: "disposition";
          attempt: number;
          summary?: string;
          headSha?: string;
        }
      | {
          kind: "retry-integration";
          attempt: number;
          reason: string;
        }
      | {
          kind: "reuse";
          attempt: number;
          commitCount: number;
          headSha?: string;
        }
      | { kind: "fresh"; attempt: number };

    let plan: AttemptPlan = { kind: "fresh", attempt: latest + 1 };
    const integratedAttempt = (active.integratedTickets ?? []).find(
      (t) => t.number === ticketNumber,
    )?.attempt;

    // Integrated attempts are history — Rework and later implements always open
    // a fresh numbered attempt rather than reusing the integrated workspace.
    if (
      integratedAttempt !== undefined &&
      latest > 0 &&
      latest <= integratedAttempt
    ) {
      plan = { kind: "fresh", attempt: integratedAttempt + 1 };
    } else if (latest >= 1) {
      const events = await bound.transcripts.read({
        workflowId: active.workflowId,
        ticketNumber,
        attempt: latest,
      });
      const history = analyzeImplementationAttemptEvents(events);

      if (history.integrationComplete) {
        plan = { kind: "fresh", attempt: latest + 1 };
      } else if (
        history.implementCompleted &&
        history.disposition === "close"
      ) {
        plan = {
          kind: "retry-integration",
          attempt: latest,
          reason:
            history.integrationFailedReason ??
            "Close disposition is pending Integration for this attempt.",
        };
      } else if (
        history.implementCompleted &&
        history.disposition === undefined
      ) {
        plan = {
          kind: "disposition",
          attempt: latest,
          ...(history.summary !== undefined
            ? { summary: history.summary }
            : {}),
          ...(history.headSha !== undefined
            ? { headSha: history.headSha }
            : {}),
        };
      } else if (
        history.implementCompleted &&
        (history.disposition === "leave-open" ||
          history.disposition === "investigate")
      ) {
        plan = { kind: "fresh", attempt: latest + 1 };
      } else if (!history.implementCompleted) {
        // Incomplete / aborted: reuse when the attempt branch has useful commits.
        try {
          const ensured = await bound.workspace.ensureImplementationWorkspace({
            workflowId: active.workflowId,
            ticketNumber,
            attempt: latest,
            baseRef,
          });
          const ahead = await bound.workspace.hasCommitsAhead({
            worktreePath: ensured.worktreePath,
            baseRef,
          });
          if (ahead.ahead) {
            plan = {
              kind: "reuse",
              attempt: latest,
              commitCount: ahead.count,
              ...(ahead.headSha !== undefined
                ? { headSha: ahead.headSha }
                : {}),
            };
          } else {
            plan = { kind: "fresh", attempt: latest + 1 };
          }
        } catch {
          plan = { kind: "fresh", attempt: latest + 1 };
        }
      }
    }

    if (plan.kind === "disposition") {
      const branchName = implementationBranchName(
        active.workflowId,
        ticketNumber,
        plan.attempt,
      );
      const worktreePath = implementationWorktreePath(
        rootPath,
        active.workflowId,
        ticketNumber,
        plan.attempt,
      );
      const workerId = `recovered-${active.workflowId}-${ticketNumber}-r${plan.attempt}`;
      pendingDisposition = {
        workerId,
        workflowId: active.workflowId,
        ticketNumber,
        attempt: plan.attempt,
        branchName,
        worktreePath,
        status: "needs-disposition",
        startedAtMs: Date.now(),
        receivedStageResult: true,
        summary:
          plan.summary ??
          (plan.headSha
            ? `Recovered completed attempt r${plan.attempt} @ ${plan.headSha.slice(0, 8)}`
            : `Recovered completed attempt r${plan.attempt}`),
      };
      implementationRecoveryCooldown.delete(ticketNumber);
      return {
        status: "needs-disposition",
        stage: "implement",
        workflowId: active.workflowId,
        ticketNumber,
        attempt: plan.attempt,
        branchName,
        worktreePath,
        workerId,
        ...(pendingDisposition.summary !== undefined
          ? { summary: pendingDisposition.summary }
          : {}),
        dispositionOptions: [...IMPLEMENTATION_DISPOSITION_OPTIONS],
      };
    }

    if (plan.kind === "retry-integration") {
      const branchName = implementationBranchName(
        active.workflowId,
        ticketNumber,
        plan.attempt,
      );
      const worktreePath = implementationWorktreePath(
        rootPath,
        active.workflowId,
        ticketNumber,
        plan.attempt,
      );
      pendingIntegration = {
        workflowId: active.workflowId,
        ticketNumber,
        attempt: plan.attempt,
        branchName,
        worktreePath,
        lastFailure: plan.reason,
      };
      implementationRecoveryCooldown.delete(ticketNumber);
      return {
        status: "failed",
        stage: "implement",
        reason: `Ticket #${ticketNumber} already has a completed Implementation attempt (r${plan.attempt}) awaiting Integration. Use Retry Integration instead of re-implementing.`,
        ticketNumber,
        attempt: plan.attempt,
      };
    }

    // Slot math + P1 gate only when we are about to open a new worker process.
    // Disposition recovery / retry-integration above do not consume a slot.
    // Already-running workers are never aborted here (P1).
    const launchBlock = await blockNewImplementationLaunch(
      bound,
      ticketNumber,
      "implement",
      active,
    );
    if (launchBlock) return launchBlock;

    const prepared = await bound.skills.prepareImplement({
      ticketNumber,
      title: ready.title,
    });
    if (!prepared.ok) {
      return {
        status: "compatibility-recovery",
        stage: "implement",
        reason: prepared.reason,
        ticketNumber,
      };
    }

    const attempt = plan.attempt;
    const reusingAttempt = plan.kind === "reuse";
    let workspace: { branchName: string; worktreePath: string };
    try {
      workspace = reusingAttempt
        ? await bound.workspace.ensureImplementationWorkspace({
            workflowId: active.workflowId,
            ticketNumber,
            attempt,
            baseRef,
          })
        : await bound.workspace.createImplementationWorkspace({
            workflowId: active.workflowId,
            ticketNumber,
            attempt,
            baseRef,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "implement",
        reason: reusingAttempt
          ? `Failed to ensure Implementation workspace for reuse: ${message}`
          : `Failed to create Implementation workspace: ${message}`,
        ticketNumber,
        attempt,
      };
    }

    // Expected branch naming is a product rule; surface mismatches fail closed.
    const expectedBranch = implementationBranchName(
      active.workflowId,
      ticketNumber,
      attempt,
    );
    if (workspace.branchName !== expectedBranch) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Implementation workspace branch "${workspace.branchName}" does not match expected "${expectedBranch}".`,
        ticketNumber,
        attempt,
      };
    }

    // Workspaces must live outside the Workflow root (sibling layout).
    const resolvedRoot = path.resolve(selectedPath ?? "");
    const resolvedWorktree = path.resolve(workspace.worktreePath);
    if (
      resolvedWorktree === resolvedRoot ||
      resolvedWorktree.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Implementation workspace must live outside the Workflow root. Received "${workspace.worktreePath}" under "${resolvedRoot}".`,
        ticketNumber,
        attempt,
      };
    }

    const workerPrompt = reusingAttempt
      ? [
          "## Resume note (orchestration-only)",
          `Relaunching a new worker on existing Implementation attempt r${attempt}.`,
          `Branch/worktree already has local commits` +
            (plan.kind === "reuse" && plan.commitCount > 0
              ? ` (${plan.commitCount} commit(s) ahead of ${baseRef}` +
                (plan.headSha ? ` @ ${plan.headSha.slice(0, 8)}` : "") +
                ")"
              : "") +
            " — continue from the workspace state, not from any prior worker dialogue.",
          "Session-owned workers use --no-session; token-level continuation is not available.",
          "",
          prepared.prompt,
        ].join("\n")
      : prepared.prompt;

    // A coordinator lease may have expired during local workspace preparation.
    // Re-prove authority before mutating repository capacity, then acquire one
    // fenced worker slot only for a coordination-aware Implementation process.
    const preSlotAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!preSlotAuthority.ok) {
      return {
        status: "failed",
        stage: "implement",
        reason: preSlotAuthority.reason,
        ticketNumber,
        attempt,
        workflowId: active.workflowId,
      };
    }

    const repositorySlot = active.coordination
      ? await acquireRepositoryWorkerSlot(bound, active, ticketNumber)
      : undefined;
    if (repositorySlot && !repositorySlot.ok) {
      return {
        status: "failed",
        stage: "implement",
        reason: repositorySlot.reason,
        ticketNumber,
        attempt,
        workflowId: active.workflowId,
      };
    }

    const workerId = `implement-${active.workflowId}-${ticketNumber}-r${attempt}`;
    const worker: ActiveImplementationWorker = {
      workerId,
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      status: "running",
      workerProfile: { ...workerProfile.profile },
      turnCount: 0,
      startedAtMs: Date.now(),
      receivedStageResult: false,
    };
    activeImplementationWorkers.set(workerId, worker);
    if (repositorySlot?.ok) {
      holdWorkerSlot(bound, {
        workerId,
        workflowId: active.workflowId,
        ticketNumber,
        lease: repositorySlot.lease,
        renewedAtMs: Date.now(),
      });
    }

    const transcriptKey = {
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
    };

    await bound.transcripts.append(transcriptKey, {
      type: "worker-launch",
      workerId,
      startedAtMs: worker.startedAtMs,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      skillCommand: prepared.skillCommand,
      ...(repositorySlot?.ok
        ? {
            workerSlot: {
              slot: repositorySlot.lease.scope.slot,
              generation: repositorySlot.lease.generation,
              capacity: repositorySlot.capacity,
            },
          }
        : {}),
      ...(reusingAttempt ? { reusedAttempt: true } : {}),
    });

    const sink: WorkerEventSink = {
      onEvent: (event) => handleWorkerEvent(bound, event),
    };

    const launchAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!launchAuthority.ok) {
      activeImplementationWorkers.delete(workerId);
      await releaseHeldWorkerSlot(bound, workerId);
      await bound.transcripts.append(transcriptKey, {
        type: "worker-launch-blocked",
        reason: launchAuthority.reason,
      });
      return {
        status: "failed",
        stage: "implement",
        reason: launchAuthority.reason,
        ticketNumber,
        attempt,
        workflowId: active.workflowId,
      };
    }

    try {
      const runtime = await bound.workers.launch(
        {
          workerId,
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          worktreePath: workspace.worktreePath,
          branchName: workspace.branchName,
          workerProfile: workerProfile.profile,
          ticketTitle: ready.title,
          prompt: workerPrompt,
          skillCommand: prepared.skillCommand,
        },
        sink,
      );
      if (typeof runtime.pid === "number") {
        worker.pid = runtime.pid;
      }
      if (runtime.alive) {
        worker.processObservedAlive = true;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "worker-process",
        workerId,
        pid: runtime.pid,
        alive: runtime.alive,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        transcriptPath: workerTranscriptPath(selectedPath ?? ports.startPath, {
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
        }),
      });
    } catch (error) {
      activeImplementationWorkers.delete(workerId);
      await releaseHeldWorkerSlot(bound, workerId);
      const message = error instanceof Error ? error.message : String(error);
      await bound.transcripts.append(transcriptKey, {
        type: "worker-launch-failed",
        reason: message,
      });
      return {
        status: "failed",
        stage: "implement",
        reason: `Failed to launch Implementation worker: ${message}`,
        ticketNumber,
        attempt,
      };
    }

    // Successful launch clears recovery cooldown for this ticket.
    implementationRecoveryCooldown.delete(ticketNumber);

    // Workers never touch the issue tracker — only the coordinator does, and
    // launch leaves GitHub recoverable (no issue mutation on start).
    return {
      status: "running",
      stage: "implement",
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
      workerId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
    };
  }

  /**
   * Move a completed Implementation worker into the single pendingDisposition
   * slot, or retain it on the multi-worker list when that slot (or Integration)
   * is already occupied. Never drops a Stage result.
   */
  function settleCompletedImplementationWorker(
    worker: ActiveImplementationWorker,
  ): void {
    worker.status = "needs-disposition";
    if (!pendingDisposition && !pendingIntegration) {
      pendingDisposition = worker;
      activeImplementationWorkers.delete(worker.workerId);
      return;
    }
    // Keep on the worker list until pendingDisposition / Integration frees.
    activeImplementationWorkers.set(worker.workerId, worker);
  }

  async function handleWorkerEvent(
    bound: RootScopedPorts,
    event: WorkerProtocolEvent,
  ): Promise<void> {
    if (activeConflictWorker?.workerId === event.workerId) {
      await handleConflictWorkerEvent(bound, event);
      return;
    }

    // Route strictly by workerId so worker A never mutates worker B.
    const worker = findImplementationWorker(event.workerId);
    if (!worker) {
      return;
    }

    await heartbeatHeldWorkflowCoordinatorLease(bound);
    // A running process must never continue to be treated as scheduled after
    // its remote worker-slot fence changes. Event traffic is an additional
    // prompt ownership check, alongside the periodic heartbeat.
    await heartbeatHeldWorkerSlots(bound, { verify: true });
    if (
      !activeImplementationWorkers.has(worker.workerId) &&
      pendingDisposition?.workerId !== worker.workerId
    ) {
      return;
    }

    const transcriptKey = {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    };
    await bound.transcripts.append(transcriptKey, event);

    if (event.type === "turn-start") {
      if (worker.status === "running") {
        worker.turnCount = (worker.turnCount ?? 0) + 1;
        worker.lastTurnStartedAtMs = event.timestampMs;
      }
      return;
    }

    if (event.type === "worker-error") {
      worker.lastError = event.message;
      if (worker.status === "running") {
        worker.progress = `error: ${event.message}`;
      }
      return;
    }

    if (event.type === "progress") {
      // Progress only mutates the addressed running worker (never worker B via A).
      if (worker.status === "running") {
        worker.progress = event.message;
      }
      return;
    }

    if (event.type === "stage-result") {
      // The Implementation process has reported its terminal result, so its
      // repository capacity becomes available before the local disposition.
      await releaseHeldWorkerSlot(bound, worker.workerId);
      // Stage results only apply to workers still in the multi-worker set.
      if (!activeImplementationWorkers.has(worker.workerId)) {
        return;
      }
      worker.receivedStageResult = true;
      if (event.outcome.status === "completed") {
        if (event.outcome.summary) {
          worker.summary = event.outcome.summary;
        }
        const telemetry = recordCompletedWorkerTelemetry(
          worker,
          "implementation",
        );
        await persistCompletedWorkerTelemetry(
          bound,
          transcriptKey,
          worker.workerId,
          telemetry,
        );
        settleCompletedImplementationWorker(worker);
        return;
      }

      worker.status = "failed";
      activeImplementationWorkers.delete(worker.workerId);
      return;
    }

    // process-exit — settle at most once per worker attempt.
    if (worker.receivedStageResult || worker.status !== "running") {
      await releaseHeldWorkerSlot(bound, worker.workerId);
      return;
    }
    if (processExitHandling.has(worker.workerId)) {
      return;
    }
    processExitHandling.add(worker.workerId);
    try {
      await releaseHeldWorkerSlot(bound, worker.workerId);
      if (worker.receivedStageResult || worker.status !== "running") {
        // Stage result / concurrent settlement won the race.
        return;
      }

      // Fallback: many agents finish with exit 0 + local commits but forget the
      // Stage result JSON. Infer completion so the pipeline can advance.
      // Base must be the Integration branch when present — comparing to main/target
      // falsely counts already-integrated commits as new ticket work.
      if (event.code === 0 || event.code === null) {
        try {
          const active = await loadActiveWorkflow(bound);
          const targetBranch = await resolveTargetBranch(
            bound.preferences,
            bound.environment,
          );
          const baseRef =
            active?.integrationBranch && active.integrationBranch.length > 0
              ? active.integrationBranch
              : targetBranch;
          const ahead = await bound.workspace.hasCommitsAhead({
            worktreePath: worker.worktreePath,
            baseRef,
          });
          if (ahead.ahead) {
            worker.receivedStageResult = true;
            const telemetry = recordCompletedWorkerTelemetry(
              worker,
              "implementation",
            );
            await persistCompletedWorkerTelemetry(
              bound,
              transcriptKey,
              worker.workerId,
              telemetry,
            );
            worker.summary =
              worker.progress ??
              `Inferred completion: ${ahead.count} commit(s) ahead of ${baseRef}` +
                (ahead.headSha ? ` @ ${ahead.headSha.slice(0, 8)}` : "");
            settleCompletedImplementationWorker(worker);
            await bound.transcripts.append(transcriptKey, {
              type: "stage-result-inferred",
              reason:
                "Worker exited without Stage result JSON; inferred completed from local commits ahead of Integration/base.",
              code: event.code,
              headSha: ahead.headSha,
              commitCount: ahead.count,
              baseRef,
            });
            return;
          }
        } catch {
          // Fall through to recovery.
        }
      }

      // Fail closed: agent settled without a Stage result and no local commits.
      worker.status = "compatibility-recovery";
      activeImplementationWorkers.delete(worker.workerId);
      // Cooldown so /matt-auto run does not immediately re-launch the same ticket.
      const recoveryReason =
        worker.lastError ??
        "Implementation worker process exited without a Stage result on the Worker protocol.";
      rememberImplementationRecovery(worker.ticketNumber, recoveryReason);
      await bound.transcripts.append(transcriptKey, {
        type: "compatibility-recovery",
        reason: recoveryReason,
        code: event.code,
        ...(worker.lastError ? { workerError: worker.lastError } : {}),
      });
    } finally {
      processExitHandling.delete(worker.workerId);
    }
  }

  async function handleConflictWorkerEvent(
    bound: RootScopedPorts,
    event: WorkerProtocolEvent,
  ): Promise<void> {
    const worker = activeConflictWorker;
    if (!worker || worker.workerId !== event.workerId) {
      return;
    }

    await heartbeatHeldWorkflowCoordinatorLease(bound);

    const transcriptKey = {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    };
    await bound.transcripts.append(transcriptKey, event);

    if (event.type === "turn-start") {
      if (worker.status === "running") {
        worker.turnCount = (worker.turnCount ?? 0) + 1;
        worker.lastTurnStartedAtMs = event.timestampMs;
      }
      return;
    }

    if (event.type === "worker-error") {
      worker.progress = `error: ${event.message}`;
      return;
    }

    if (event.type === "progress") {
      worker.progress = event.message;
      return;
    }

    if (event.type === "stage-result") {
      worker.receivedStageResult = true;
      if (event.outcome.status === "completed") {
        const telemetry = recordCompletedWorkerTelemetry(
          worker,
          "conflict-resolution",
        );
        await persistCompletedWorkerTelemetry(
          bound,
          transcriptKey,
          worker.workerId,
          telemetry,
        );
        worker.status = "completed";
        activeConflictWorker = undefined;

        if (worker.resolutionKind === "target-refresh") {
          const pending = pendingTargetRefresh;
          if (!pending || pending.workflowId !== worker.workflowId) {
            return;
          }
          delete pending.conflict;
          delete pending.lastFailure;
          if (worker.targetSha) pending.targetSha = worker.targetSha;
          targetRefreshInProgress = true;
          try {
            await finishTargetRefreshAfterMerge(bound, pending);
          } finally {
            targetRefreshInProgress = false;
          }
          return;
        }

        const unit = pendingIntegration;
        if (
          !unit ||
          unit.ticketNumber !== worker.ticketNumber ||
          unit.workflowId !== worker.workflowId
        ) {
          return;
        }

        const integrationWorkspace = {
          branchName: worker.integrationBranch,
          worktreePath: worker.integrationWorktreePath,
        };
        delete unit.conflict;
        delete unit.lastFailure;

        // Mark in-progress so nextActions does not re-offer Retry / auto-advance
        // into a second concurrent finish while this one is still running.
        integrationInProgress = true;
        try {
          await finishIntegrationAfterMerge(bound, unit, integrationWorkspace);
        } finally {
          integrationInProgress = false;
        }
        return;
      }

      worker.status = "failed";
      activeConflictWorker = undefined;
      await bound.transcripts.append(transcriptKey, {
        type: "conflict-resolution-failed",
        reason: event.outcome.reason,
        resolutionKind: worker.resolutionKind,
      });

      if (worker.resolutionKind === "target-refresh") {
        if (
          pendingTargetRefresh &&
          pendingTargetRefresh.workflowId === worker.workflowId
        ) {
          pendingTargetRefresh.lastFailure = `Conflict resolution failed: ${event.outcome.reason}`;
        }
        await failTargetRefresh(bound, {
          failureKind: "deterministic",
          reason: TARGET_REFRESH_FAILURE_REASONS.conflictResolutionFailed,
          detail: event.outcome.reason,
        });
        return;
      }

      if (
        pendingIntegration &&
        pendingIntegration.ticketNumber === worker.ticketNumber
      ) {
        pendingIntegration.lastFailure = `Conflict resolution failed: ${event.outcome.reason}`;
      }
      return;
    }

    if (worker.receivedStageResult) {
      return;
    }

    worker.status = "compatibility-recovery";
    activeConflictWorker = undefined;
    const reason =
      worker.resolutionKind === "target-refresh"
        ? "Target-refresh Conflict resolution worker process exited without a Stage result on the Worker protocol. Matt Auto entered Compatibility recovery rather than guessing merges."
        : "Conflict resolution worker process exited without a Stage result on the Worker protocol. Matt Auto entered Compatibility recovery rather than guessing merges.";
    await bound.transcripts.append(transcriptKey, {
      type: "compatibility-recovery",
      reason,
      code: event.code,
      resolutionKind: worker.resolutionKind,
    });

    if (worker.resolutionKind === "target-refresh") {
      if (
        pendingTargetRefresh &&
        pendingTargetRefresh.workflowId === worker.workflowId
      ) {
        pendingTargetRefresh.lastFailure = `Compatibility recovery: ${reason}`;
      }
      await failTargetRefresh(bound, {
        failureKind: "deterministic",
        reason: TARGET_REFRESH_FAILURE_REASONS.missingStageResult,
        detail: reason,
      });
      return;
    }

    if (
      pendingIntegration &&
      pendingIntegration.ticketNumber === worker.ticketNumber
    ) {
      pendingIntegration.lastFailure = `Compatibility recovery: ${reason}`;
    }
  }

  async function confirmDisposition(
    decision: ImplementationDispositionDecision,
  ): Promise<StageResult> {
    if (!pendingDisposition) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "No pending Implementation disposition. Wait for a successful Implementation worker Stage result first.",
      };
    }

    if (
      decision !== "close" &&
      decision !== "leave-open" &&
      decision !== "investigate"
    ) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Unknown Implementation disposition "${String(decision)}".`,
      };
    }

    const current = pendingDisposition;
    const bound = await requireScoped();
    const transcriptKey = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
    };

    await bound.transcripts.append(transcriptKey, {
      type: "disposition",
      decision,
    });

    pendingDisposition = undefined;
    current.status = "completed";

    // Leave open / Investigate: no Integration unit, no remote writes, ticket stays open.
    if (decision !== "close") {
      // Free the single disposition slot for the next completed multi-worker.
      promoteNextPendingDisposition();
      return {
        status: "completed",
        stage: "implement",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        disposition: decision,
        integrated: false,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    // Close starts a serialized Integration unit; ticket is not closed yet.
    if (pendingIntegration) {
      return {
        status: "failed",
        stage: "integrate",
        reason: `An Integration unit is already pending for #${pendingIntegration.ticketNumber}. Integration units process one completed ticket at a time.`,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
      };
    }

    pendingIntegration = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
    };

    return runIntegrationUnit(bound, pendingIntegration);
  }

  async function retryIntegration(ticketNumber: number): Promise<StageResult> {
    if (!pendingIntegration || pendingIntegration.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "integrate",
        reason: `No pending Integration unit for #${ticketNumber}.`,
        ticketNumber,
      };
    }

    const bound = await requireScoped();
    return runIntegrationUnit(bound, pendingIntegration);
  }

  /**
   * Serialized Integration unit:
   * 1. Ensure Integration workspace (dedicated worktree, not Workflow home)
   * 2. Merge ticket branch into Integration branch (local only)
   * 3. Local verification (project-discoverable checks)
   * 4. Coordinator remote writes (push + Workflow manifest update)
   *
   * Fail closed: no remote advancement on merge or verification failure.
   * Tickets stay open until the CI gate (later ticket).
   */
  async function runIntegrationUnit(
    bound: RootScopedPorts,
    unit: PendingIntegration,
  ): Promise<StageResult> {
    if (integrationInProgress) {
      // Same unit may still be finishing (e.g. post-conflict finishIntegrationAfterMerge
      // in flight). Do not hard-fail the pipeline — wait loop treats integrate
      // "running" as live work. Different ticket still blocked.
      if (pendingIntegration?.ticketNumber === unit.ticketNumber) {
        return {
          status: "running",
          stage: "integrate",
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workerId: activeConflictWorker?.workerId ?? `integrate-${unit.ticketNumber}`,
          integrationBranch:
            unit.conflict?.integrationBranch ??
            integrationBranchName(unit.workflowId),
          ...(unit.conflict?.integrationWorktreePath
            ? {
                integrationWorktreePath: unit.conflict.integrationWorktreePath,
              }
            : {}),
        };
      }
      return {
        status: "failed",
        stage: "integrate",
        reason:
          "An Integration unit is already in progress. Integration units process one completed ticket at a time.",
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    if (activeConflictWorker) {
      if (activeConflictWorker.ticketNumber === unit.ticketNumber) {
        return {
          status: "running",
          stage: "integrate",
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workerId: activeConflictWorker.workerId,
          integrationBranch: activeConflictWorker.integrationBranch,
          integrationWorktreePath: activeConflictWorker.integrationWorktreePath,
          conflictResolution: true,
        };
      }
      return {
        status: "failed",
        stage: "integrate",
        reason: `A Conflict resolution worker is already running for #${activeConflictWorker.ticketNumber}.`,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    if (unit.conflict) {
      return launchConflictWorker(bound, unit, unit.conflict);
    }

    integrationInProgress = true;
    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);

    try {
      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-start",
        ticketBranch: unit.branchName,
      });

      const active = await loadActiveWorkflow(bound);
      if (!active || active.workflowId !== unit.workflowId) {
        const reason =
          "No Active workflow matches this Integration unit. Recover Workflow state before retrying.";
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      const integrationAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!integrationAuthority.ok) {
        unit.lastFailure = integrationAuthority.reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason: integrationAuthority.reason,
          phase: "coordinator-lease",
        });
        return {
          status: "failed",
          stage: "integrate",
          reason: integrationAuthority.reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workflowId: active.workflowId,
        };
      }

      // Already integrated (e.g. recovered from manifest) — do not re-merge.
      if (active.integratedTickets?.some((t) => t.number === unit.ticketNumber)) {
        pendingIntegration = undefined;
        promoteNextPendingDisposition();
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-skipped",
          reason: "Ticket already recorded as integrated on the Workflow manifest.",
        });
        return {
          status: "completed",
          stage: "integrate",
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          disposition: "close",
          integrated: true,
          integrationBranch:
            active.integrationBranch ?? integrationBranchName(unit.workflowId),
          branchName: unit.branchName,
          worktreePath: unit.worktreePath,
        };
      }

      const targetBranch = await resolveTargetBranch(bound.preferences, bound.environment);
      const expectedIntegrationBranch = integrationBranchName(unit.workflowId);

      let integrationWorkspace: { branchName: string; worktreePath: string };
      try {
        integrationWorkspace = await bound.workspace.ensureIntegrationWorkspace({
          workflowId: unit.workflowId,
          baseRef: active.integrationBranch ?? targetBranch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Failed to create Integration workspace: ${message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      if (integrationWorkspace.branchName !== expectedIntegrationBranch) {
        const reason = `Integration workspace branch "${integrationWorkspace.branchName}" does not match expected "${expectedIntegrationBranch}".`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Integration workspace must live outside the Workflow root.
      const resolvedRoot = path.resolve(selectedPath ?? "");
      const resolvedIntegration = path.resolve(integrationWorkspace.worktreePath);
      if (
        resolvedIntegration === resolvedRoot ||
        resolvedIntegration.startsWith(`${resolvedRoot}${path.sep}`)
      ) {
        const reason = `Integration workspace must live outside the Workflow root. Received "${integrationWorkspace.worktreePath}" under "${resolvedRoot}".`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Dual-root: publish ticket-branch submodule commits BEFORE merge.
      // Git cannot merge gitlinks when the target SHA is missing from the object
      // store / remote ("無法合併子模組 … 提交不存在").
      const preMergePublish = await ensureSubmoduleGitlinksPublished(
        unit.worktreePath,
      );
      if (!preMergePublish.ok) {
        const reason = `Cannot integrate #${unit.ticketNumber}: ${preMergePublish.reason}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "submodule-pre-merge-publish",
          ...(preMergePublish.path
            ? { submodulePath: preMergePublish.path }
            : {}),
          ...(preMergePublish.sha ? { submoduleSha: preMergePublish.sha } : {}),
          ...(preMergePublish.remote
            ? { submoduleRemote: preMergePublish.remote }
            : {}),
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }
      if (preMergePublish.published.length > 0) {
        await bound.transcripts.append(transcriptKey, {
          type: "submodule-publish",
          phase: "pre-merge",
          published: preMergePublish.published,
        });
      }

      // Local merge only — no push yet.
      const mergeResult = await bound.workspace.mergeIntoIntegration({
        workflowId: unit.workflowId,
        ticketBranch: unit.branchName,
      });
      if (!mergeResult.ok) {
        if (mergeResult.reason === "conflict") {
          const conflict = {
            integrationBranch: expectedIntegrationBranch,
            integrationWorktreePath: integrationWorkspace.worktreePath,
            message: mergeResult.message,
          };
          unit.conflict = conflict;
          unit.lastFailure = `Merge conflict integrating ${unit.branchName} into ${expectedIntegrationBranch}: ${mergeResult.message}`;
          await bound.transcripts.append(transcriptKey, {
            type: "integration-unit-conflict",
            reason: unit.lastFailure,
            phase: "merge",
          });
          integrationInProgress = false;
          return launchConflictWorker(bound, unit, conflict);
        }

        const reason = `Failed to merge ${unit.branchName} into ${expectedIntegrationBranch}: ${mergeResult.message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "merge",
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-merged",
        integrationBranch: expectedIntegrationBranch,
        mergeCommitSha: mergeResult.mergeCommitSha,
      });

      // Await so the finally block does not clear integrationInProgress while
      // finishIntegrationAfterMerge is still running (retry race).
      return await finishIntegrationAfterMerge(
        bound,
        unit,
        integrationWorkspace,
      );
    } finally {
      stopHeartbeat();
      integrationInProgress = false;
    }
  }


  async function launchConflictWorker(
    bound: RootScopedPorts,
    unit: PendingIntegration,
    conflict: {
      integrationBranch: string;
      integrationWorktreePath: string;
      message: string;
    },
  ): Promise<StageResult> {
    unit.conflict = conflict;

    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };

    const active = await loadActiveWorkflow(bound, { force: true });
    if (!active || active.workflowId !== unit.workflowId) {
      const reason =
        "No bound Active workflow matches this Conflict resolution worker. Recover Workflow-home routing before retrying.";
      unit.lastFailure = reason;
      return {
        status: "failed",
        stage: "integrate",
        reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }
    const conflictAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!conflictAuthority.ok) {
      unit.lastFailure = conflictAuthority.reason;
      return {
        status: "failed",
        stage: "integrate",
        reason: conflictAuthority.reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
        workflowId: active.workflowId,
      };
    }

    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      const reason =
        "Cannot launch a Conflict resolution worker without a Worker profile.";
      unit.lastFailure = reason;
      return {
        status: "failed",
        stage: "integrate",
        reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    const prepared = await bound.skills.prepareResolveConflicts(
      ticketIntegrationConflictSkillInput({
        ticketNumber: unit.ticketNumber,
        ticketBranch: unit.branchName,
        integrationBranch: conflict.integrationBranch,
      }),
    );
    if (!prepared.ok) {
      unit.lastFailure = prepared.reason;
      return {
        status: "compatibility-recovery",
        stage: "integrate",
        reason: prepared.reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    const workerId = `conflict-${unit.workflowId}-${unit.ticketNumber}-r${unit.attempt}`;
    const worker: ActiveConflictWorker = {
      workerId,
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
      resolutionKind: "ticket-integration",
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      status: "running",
      workerProfile: { ...workerProfile.profile },
      turnCount: 0,
      startedAtMs: Date.now(),
      receivedStageResult: false,
    };
    activeConflictWorker = worker;

    await bound.transcripts.append(transcriptKey, {
      type: "conflict-resolution-launch",
      workerId,
      startedAtMs: worker.startedAtMs,
      skillCommand: prepared.skillCommand,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      message: conflict.message,
    });

    const sink: WorkerEventSink = {
      onEvent: (event) => handleWorkerEvent(bound, event),
    };

    const launchAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!launchAuthority.ok) {
      activeConflictWorker = undefined;
      unit.lastFailure = launchAuthority.reason;
      await bound.transcripts.append(transcriptKey, {
        type: "conflict-resolution-launch-blocked",
        reason: launchAuthority.reason,
      });
      return {
        status: "failed",
        stage: "integrate",
        reason: launchAuthority.reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
        workflowId: active.workflowId,
      };
    }

    try {
      const runtime = await bound.workers.launch(
        {
          workerId,
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          worktreePath: conflict.integrationWorktreePath,
          branchName: conflict.integrationBranch,
          workerProfile: workerProfile.profile,
          ticketTitle: `Conflict resolution for #${unit.ticketNumber}`,
          prompt: prepared.prompt,
          skillCommand: prepared.skillCommand,
        },
        sink,
      );
      if (typeof runtime.pid === "number") {
        worker.pid = runtime.pid;
      }
      if (runtime.alive) {
        worker.processObservedAlive = true;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "worker-process",
        workerId,
        pid: runtime.pid,
        alive: runtime.alive,
        worktreePath: conflict.integrationWorktreePath,
        branchName: conflict.integrationBranch,
        transcriptPath: workerTranscriptPath(selectedPath ?? ports.startPath, {
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        }),
      });
    } catch (error) {
      activeConflictWorker = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Failed to launch Conflict resolution worker: ${message}`;
      unit.lastFailure = reason;
      await bound.transcripts.append(transcriptKey, {
        type: "conflict-resolution-launch-failed",
        reason,
      });
      return {
        status: "failed",
        stage: "integrate",
        reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    return {
      status: "running",
      stage: "integrate",
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
      workerId,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      conflictResolution: true,
    };
  }

  async function finishIntegrationAfterMerge(
    bound: RootScopedPorts,
    unit: PendingIntegration,
    integrationWorkspace: { branchName: string; worktreePath: string },
  ): Promise<StageResult> {
    const heldGuard = !integrationInProgress;
    if (heldGuard) {
      integrationInProgress = true;
    }

    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);

    try {
      const active = await loadActiveWorkflow(bound);
      if (!active || active.workflowId !== unit.workflowId) {
        const reason =
          "No Active workflow matches this Integration unit. Recover Workflow state before retrying.";
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      const finishAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!finishAuthority.ok) {
        unit.lastFailure = finishAuthority.reason;
        return {
          status: "failed",
          stage: "integrate",
          reason: finishAuthority.reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workflowId: active.workflowId,
        };
      }

      // Dual-root: push local-only submodule commits, then fail closed if any
      // gitlink is still missing on the submodule remote (issue #30).
      const submoduleGate = await ensureSubmoduleGitlinksPublished(
        integrationWorkspace.worktreePath,
      );
      if (!submoduleGate.ok) {
        const reason = submoduleGate.reason;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "submodule-gate",
          ...(submoduleGate.path ? { submodulePath: submoduleGate.path } : {}),
          ...(submoduleGate.sha ? { submoduleSha: submoduleGate.sha } : {}),
          ...(submoduleGate.remote ? { submoduleRemote: submoduleGate.remote } : {}),
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }
      if (submoduleGate.published.length > 0) {
        await bound.transcripts.append(transcriptKey, {
          type: "submodule-publish",
          published: submoduleGate.published,
        });
      }
      if (submoduleGate.checked.length > 0) {
        await bound.transcripts.append(transcriptKey, {
          type: "submodule-gate",
          checked: submoduleGate.checked,
          publishedCount: submoduleGate.published.length,
        });
      }

      // Local verification before any remote write.
      const verification = await bound.verification.runLocalVerification(
        integrationWorkspace.worktreePath,
      );
      if (!verification.ok) {
        const reason = `Local verification failed in the Integration workspace: ${verification.reason}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "local-verification",
          commands: verification.commands,
        });
        // Fail closed: no push, no manifest update.
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      await bound.transcripts.append(transcriptKey, {
        type: "local-verification",
        commands: verification.commands,
      });

      // Coordinator-only remote writes: push Integration + ticket branches.
      const pushAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!pushAuthority.ok) {
        unit.lastFailure = pushAuthority.reason;
        return {
          status: "failed",
          stage: "integrate",
          reason: pushAuthority.reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workflowId: active.workflowId,
        };
      }
      const pushedBranches: string[] = [];
      try {
        await bound.remoteGit.pushBranch(integrationWorkspace.branchName);
        pushedBranches.push(integrationWorkspace.branchName);
        await bound.remoteGit.pushBranch(unit.branchName);
        pushedBranches.push(unit.branchName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Coordinator remote push failed after Local verification: ${message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "push",
          pushedBranches,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      const integratedTickets = [
        ...(active.integratedTickets ?? []),
        {
          number: unit.ticketNumber,
          attempt: unit.attempt,
          branchName: unit.branchName,
        },
      ];

      const manifest = manifestFromActive(active, {
        integrationBranch: integrationWorkspace.branchName,
        integratedTickets,
      });

      const manifestAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!manifestAuthority.ok) {
        const reason = manifestAuthority.reason;
        unit.lastFailure = reason;
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          workflowId: active.workflowId,
        };
      }

      try {
        await bound.tracker.writeWorkflowManifest(
          active.workflowId,
          manifestWithCoordinatorLeaseGeneration(manifest, manifestAuthority.lease),
        );
        invalidatePanelCaches();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Pushed ${pushedBranches.join(", ")} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId} before continuing.`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "manifest",
          pushedBranches,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      pendingIntegration = undefined;
      // Integration slot free — promote any completed worker waiting for disposition.
      promoteNextPendingDisposition();

      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-completed",
        integrationBranch: integrationWorkspace.branchName,
        pushedBranches,
      });

      // On-demand CI gate once after push — never poll. Pending returns control immediately.
      return applyCiGate(bound, {
        workflowId: unit.workflowId,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
        branchName: unit.branchName,
        worktreePath: unit.worktreePath,
        integrationBranch: integrationWorkspace.branchName,
        integrationWorktreePath: integrationWorkspace.worktreePath,
        localVerification: {
          ok: true,
          commands: verification.commands,
        },
        pushedBranches,
        rePush: false,
      });
    } finally {
      stopHeartbeat();
      if (heldGuard) {
        integrationInProgress = false;
      }
    }
  }

  function targetRefreshTranscriptKey(pending: PendingTargetRefresh) {
    return {
      workflowId: pending.workflowId,
      ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
      attempt: pending.attempt,
    };
  }

  function clearTargetRefreshState(): void {
    pendingTargetRefresh = undefined;
    targetRefreshInProgress = false;
    targetDeliveryQueue = undefined;
  }

  async function ensureTargetDeliveryQueue(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<
    | { ok: true; queue: TargetBranchQueueOrchestrator }
    | { ok: false; reason: string }
  > {
    if (!active.coordination) {
      return {
        ok: false,
        reason:
          "Target-branch refresh requires a coordination-aware Workflow manifest.",
      };
    }
    if (!bound.coordination) {
      return {
        ok: false,
        reason:
          "Target-branch refresh requires a CoordinationPort on this Workflow root.",
      };
    }
    if (targetDeliveryQueue) {
      return { ok: true, queue: targetDeliveryQueue };
    }
    const queue = createTargetBranchQueueOrchestrator({
      target: active.coordination.target,
      workflowId: active.workflowId,
      holderId: workflowHomeHolderId,
      coordination: bound.coordination,
      store: {
        listActiveWorkflows: (target) => bound.tracker.findActiveWorkflows(target),
        writeWorkflowManifest: (workflowId, manifest) =>
          bound.tracker.writeWorkflowManifest(workflowId, manifest),
      },
    });
    targetDeliveryQueue = queue;
    return { ok: true, queue };
  }

  async function failTargetRefresh(
    bound: RootScopedPorts,
    input: {
      failureKind: "transient" | "deterministic";
      reason: string;
      detail?: string;
    },
  ): Promise<StageResult> {
    const pending = pendingTargetRefresh;
    const workflowId = pending?.workflowId;
    const attempt = pending?.attempt ?? 1;
    const detailReason = input.detail
      ? `${input.reason}: ${input.detail}`
      : input.reason;

    if (pending) {
      pending.lastFailure = detailReason;
      await bound.transcripts.append(targetRefreshTranscriptKey(pending), {
        type: "target-refresh-failed",
        reason: detailReason,
        failureKind: input.failureKind,
      });
    }

    const active =
      workflowId !== undefined
        ? await loadActiveWorkflow(bound, { force: true })
        : undefined;
    if (
      active &&
      active.workflowId === workflowId &&
      active.coordination &&
      bound.coordination
    ) {
      const authority = await ensureActiveWorkflowCoordinatorLease(bound, active);
      if (authority.ok && authority.lease) {
        const queueResult = await ensureTargetDeliveryQueue(bound, active);
        if (queueResult.ok) {
          await recordTargetRefreshFailure({
            queue: queueResult.queue,
            workflowCoordinatorLease: authority.lease,
            failureKind: input.failureKind,
            reason: input.reason,
          });
        } else if (targetDeliveryQueue) {
          await targetDeliveryQueue.transition({
            kind: "release-held-target-lease",
          });
        }
      } else if (targetDeliveryQueue) {
        await targetDeliveryQueue.transition({
          kind: "release-held-target-lease",
        });
      }
    } else if (targetDeliveryQueue) {
      await targetDeliveryQueue.transition({ kind: "release-held-target-lease" });
    }

    clearTargetRefreshState();
    return {
      status: "failed",
      stage: "target-refresh",
      reason: detailReason,
      ...(workflowId !== undefined ? { workflowId } : {}),
      attempt,
      ...(pending?.integrationBranch
        ? { integrationBranch: pending.integrationBranch }
        : {}),
      ...(pending?.targetBranch ? { targetBranch: pending.targetBranch } : {}),
      ...(pending?.targetSha
        ? { validatedTargetSha: pending.targetSha }
        : {}),
    };
  }

  async function finishTargetRefreshAfterMerge(
    bound: RootScopedPorts,
    pending: PendingTargetRefresh,
  ): Promise<StageResult> {
    const heldGuard = !targetRefreshInProgress;
    if (heldGuard) targetRefreshInProgress = true;
    const transcriptKey = targetRefreshTranscriptKey(pending);
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);

    try {
      const active = await loadActiveWorkflow(bound, { force: true });
      if (!active || active.workflowId !== pending.workflowId) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
          detail:
            "No bound Active workflow matches this Target-branch refresh.",
        });
      }
      if (!active.coordination?.prFreshness) {
        return failTargetRefresh(bound, {
          failureKind: "deterministic",
          reason: TARGET_REFRESH_FAILURE_REASONS.prUpdateFailed,
          detail:
            "Workflow PR freshness facts are required to persist the refreshed Target SHA.",
        });
      }
      if (!pending.targetSha) {
        return failTargetRefresh(bound, {
          failureKind: "deterministic",
          reason: TARGET_REFRESH_FAILURE_REASONS.mergeError,
          detail: "Target-branch refresh completed without a recorded Target SHA.",
        });
      }

      const authority = await ensureActiveWorkflowCoordinatorLease(bound, active);
      if (!authority.ok || !authority.lease) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
          detail: authority.ok
            ? "Workflow coordinator lease is unavailable for Target-refresh finalization."
            : authority.reason,
        });
      }

      const queueResult = await ensureTargetDeliveryQueue(bound, active);
      if (!queueResult.ok) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
          detail: queueResult.reason,
        });
      }

      // Renew the Target-branch lease while local verification runs.
      await queueResult.queue.transition({ kind: "renew-held-target-lease" });

      const verification = await bound.verification.runLocalVerification(
        pending.integrationWorktreePath,
      );
      if (!verification.ok) {
        return failTargetRefresh(bound, {
          failureKind: "deterministic",
          reason: TARGET_REFRESH_FAILURE_REASONS.localVerificationFailed,
          detail: verification.reason,
        });
      }
      await bound.transcripts.append(transcriptKey, {
        type: "target-refresh-local-verification",
        commands: verification.commands,
      });

      const pushAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!pushAuthority.ok || !pushAuthority.lease) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
          detail: pushAuthority.ok
            ? "Workflow coordinator lease is unavailable for Target-refresh push."
            : pushAuthority.reason,
        });
      }

      try {
        await bound.remoteGit.pushBranch(pending.integrationBranch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.pushFailed,
          detail: message,
        });
      }

      const head = await bound.workspace.hasCommitsAhead({
        worktreePath: pending.integrationWorktreePath,
        baseRef: pending.targetBranch,
      });
      const headSha = head.headSha;
      if (!headSha) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.prUpdateFailed,
          detail: "Could not resolve the refreshed Integration head SHA after push.",
        });
      }

      const prFreshness = refreshedWorkflowPrFreshness({
        headSha,
        validatedTargetSha: pending.targetSha,
        mergeMethod: active.coordination.prFreshness.mergeMethod,
      });

      const releaseAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!releaseAuthority.ok || !releaseAuthority.lease) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
          detail: releaseAuthority.ok
            ? "Workflow coordinator lease is unavailable for Target-refresh PR update."
            : releaseAuthority.reason,
        });
      }

      let admitMergeReady = false;
      if (typeof bound.tracker.inspectProtectedBranchAutomation === "function") {
        try {
          const policy = await bound.tracker.inspectProtectedBranchAutomation({
            targetBranch: pending.targetBranch,
          });
          admitMergeReady = !policyRequiresStatusChecks(policy);
        } catch {
          admitMergeReady = false;
        }
      }

      const released = await releaseTargetRefreshForPrChecks({
        queue: queueResult.queue,
        workflowCoordinatorLease: releaseAuthority.lease,
        prFreshness,
        ...(admitMergeReady ? { admitMergeReady: true } : {}),
      });
      if (!released.ok) {
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.prUpdateFailed,
          detail: released.reason,
        });
      }

      await bound.transcripts.append(transcriptKey, {
        type: "target-refresh-completed",
        targetSha: pending.targetSha,
        headSha,
        integrationBranch: pending.integrationBranch,
        pushedBranches: [pending.integrationBranch],
      });

      clearTargetRefreshState();
      invalidatePanelCaches();

      return {
        status: "completed",
        stage: "target-refresh",
        workflowId: pending.workflowId,
        attempt: pending.attempt,
        integrationBranch: pending.integrationBranch,
        integrationWorktreePath: pending.integrationWorktreePath,
        targetBranch: pending.targetBranch,
        validatedTargetSha: pending.targetSha,
        headSha,
        localVerification: {
          ok: true,
          commands: verification.commands,
        },
        pushedBranches: [pending.integrationBranch],
      };
    } finally {
      stopHeartbeat();
      if (heldGuard) targetRefreshInProgress = false;
    }
  }

  async function launchTargetRefreshConflictWorker(
    bound: RootScopedPorts,
    pending: PendingTargetRefresh,
    conflict: TargetRefreshConflict,
  ): Promise<StageResult> {
    pending.conflict = conflict;
    pending.targetSha = conflict.targetSha;
    const transcriptKey = targetRefreshTranscriptKey(pending);

    const active = await loadActiveWorkflow(bound, { force: true });
    if (!active || active.workflowId !== pending.workflowId) {
      return failTargetRefresh(bound, {
        failureKind: "transient",
        reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
        detail:
          "No bound Active workflow matches this Target-refresh Conflict resolution worker.",
      });
    }
    const conflictAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!conflictAuthority.ok || !conflictAuthority.lease) {
      return failTargetRefresh(bound, {
        failureKind: "transient",
        reason: TARGET_REFRESH_FAILURE_REASONS.authorityLost,
        detail: conflictAuthority.ok
          ? "Workflow coordinator lease is unavailable for Target-refresh Conflict resolution."
          : conflictAuthority.reason,
      });
    }

    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return failTargetRefresh(bound, {
        failureKind: "deterministic",
        reason: TARGET_REFRESH_FAILURE_REASONS.conflictResolutionFailed,
        detail:
          "Cannot launch a Target-refresh Conflict resolution worker without a Worker profile.",
      });
    }

    const prepared = await bound.skills.prepareResolveConflicts(
      targetRefreshConflictSkillInput(conflict, pending.workflowId),
    );
    if (!prepared.ok) {
      pending.lastFailure = prepared.reason;
      await failTargetRefresh(bound, {
        failureKind: "deterministic",
        reason: TARGET_REFRESH_FAILURE_REASONS.conflictResolutionFailed,
        detail: prepared.reason,
      });
      return {
        status: "compatibility-recovery",
        stage: "target-refresh",
        reason: prepared.reason,
        attempt: pending.attempt,
      };
    }

    const workerId = `conflict-refresh-${pending.workflowId}-r${pending.attempt}`;
    const worker: ActiveConflictWorker = {
      workerId,
      workflowId: pending.workflowId,
      ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
      attempt: pending.attempt,
      resolutionKind: "target-refresh",
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      targetBranch: conflict.targetBranch,
      targetSha: conflict.targetSha,
      ...(conflict.targetLeaseGeneration !== undefined
        ? { targetLeaseGeneration: conflict.targetLeaseGeneration }
        : {}),
      status: "running",
      workerProfile: { ...workerProfile.profile },
      turnCount: 0,
      startedAtMs: Date.now(),
      receivedStageResult: false,
    };
    activeConflictWorker = worker;

    await bound.transcripts.append(transcriptKey, {
      type: "conflict-resolution-launch",
      workerId,
      startedAtMs: worker.startedAtMs,
      skillCommand: prepared.skillCommand,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      message: conflict.message,
      resolutionKind: "target-refresh",
      targetBranch: conflict.targetBranch,
      targetSha: conflict.targetSha,
      ...(conflict.targetLeaseGeneration !== undefined
        ? { targetLeaseGeneration: conflict.targetLeaseGeneration }
        : {}),
    });

    const sink: WorkerEventSink = {
      onEvent: (event) => handleWorkerEvent(bound, event),
    };

    try {
      const runtime = await bound.workers.launch(
        {
          workerId,
          workflowId: pending.workflowId,
          ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
          attempt: pending.attempt,
          worktreePath: conflict.integrationWorktreePath,
          branchName: conflict.integrationBranch,
          workerProfile: workerProfile.profile,
          ticketTitle: `Target-refresh conflict resolution for Workflow #${pending.workflowId}`,
          prompt: prepared.prompt,
          skillCommand: prepared.skillCommand,
        },
        sink,
      );
      if (typeof runtime.pid === "number") {
        worker.pid = runtime.pid;
      }
      if (runtime.alive) {
        worker.processObservedAlive = true;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "worker-process",
        workerId,
        pid: runtime.pid,
        alive: runtime.alive,
        worktreePath: conflict.integrationWorktreePath,
        branchName: conflict.integrationBranch,
        transcriptPath: workerTranscriptPath(selectedPath ?? ports.startPath, {
          workflowId: pending.workflowId,
          ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
          attempt: pending.attempt,
        }),
      });
    } catch (error) {
      activeConflictWorker = undefined;
      const message = error instanceof Error ? error.message : String(error);
      return failTargetRefresh(bound, {
        failureKind: "transient",
        reason: TARGET_REFRESH_FAILURE_REASONS.conflictResolutionFailed,
        detail: `Failed to launch Target-refresh Conflict resolution worker: ${message}`,
      });
    }

    return {
      status: "running",
      stage: "target-refresh",
      workflowId: pending.workflowId,
      attempt: pending.attempt,
      workerId,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      targetBranch: conflict.targetBranch,
      targetSha: conflict.targetSha,
      conflictResolution: true,
    };
  }

  /**
   * Target-branch refresh delivery path:
   * 1. Acquire Target-branch lease as FIFO queue head (merge-ready → refreshing)
   * 2. Fetch + merge Target into Integration (never rebase / never push Target)
   * 3. On conflict: launch Conflict resolution worker with target-refresh context
   * 4. On clean/resolved: Local verification → push Integration → update PR freshness
   * 5. Release Target-branch lease while remote PR checks re-run
   */
  async function runTargetRefresh(): Promise<StageResult> {
    const bound = await requireScoped();

    if (pendingIntegration || integrationInProgress) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason:
          "Cannot refresh from the Target branch while an Integration unit is pending.",
      };
    }
    if (
      activeConflictWorker &&
      activeConflictWorker.resolutionKind === "ticket-integration"
    ) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason: `A ticket-to-Integration Conflict resolution worker is already running for #${activeConflictWorker.ticketNumber}.`,
      };
    }

    if (
      pendingTargetRefresh?.conflict &&
      activeConflictWorker?.resolutionKind === "target-refresh"
    ) {
      return {
        status: "running",
        stage: "target-refresh",
        workflowId: pendingTargetRefresh.workflowId,
        attempt: pendingTargetRefresh.attempt,
        workerId: activeConflictWorker.workerId,
        integrationBranch: activeConflictWorker.integrationBranch,
        integrationWorktreePath: activeConflictWorker.integrationWorktreePath,
        targetBranch:
          activeConflictWorker.targetBranch ?? pendingTargetRefresh.targetBranch,
        ...(activeConflictWorker.targetSha
          ? { targetSha: activeConflictWorker.targetSha }
          : {}),
        conflictResolution: true,
      };
    }

    if (pendingTargetRefresh?.conflict && !activeConflictWorker) {
      return launchTargetRefreshConflictWorker(
        bound,
        pendingTargetRefresh,
        pendingTargetRefresh.conflict,
      );
    }

    if (targetRefreshInProgress && pendingTargetRefresh) {
      return {
        status: "running",
        stage: "target-refresh",
        workflowId: pendingTargetRefresh.workflowId,
        attempt: pendingTargetRefresh.attempt,
        workerId: `target-refresh-${pendingTargetRefresh.workflowId}`,
        integrationBranch: pendingTargetRefresh.integrationBranch,
        integrationWorktreePath: pendingTargetRefresh.integrationWorktreePath,
        targetBranch: pendingTargetRefresh.targetBranch,
        ...(pendingTargetRefresh.targetSha
          ? { targetSha: pendingTargetRefresh.targetSha }
          : {}),
      };
    }

    const active = await loadActiveWorkflow(bound, { force: true });
    if (!active || active.stage !== "pr-opened" || !active.workflowPr) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason:
          "Target-branch refresh requires an open Workflow PR on a coordination-aware Active workflow.",
      };
    }
    if (!active.coordination) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason:
          "Target-branch refresh is only available for coordination-aware workflows.",
        workflowId: active.workflowId,
      };
    }
    if (!active.integrationBranch) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason:
          "Target-branch refresh requires an Integration branch on the Workflow manifest.",
        workflowId: active.workflowId,
      };
    }

    const authority = await ensureActiveWorkflowCoordinatorLease(bound, active);
    if (!authority.ok || !authority.lease) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason: authority.ok
          ? "Workflow coordinator lease is unavailable for Target-branch refresh."
          : authority.reason,
        workflowId: active.workflowId,
      };
    }
    const workflowCoordinatorLease = authority.lease;

    const queueResult = await ensureTargetDeliveryQueue(bound, active);
    if (!queueResult.ok) {
      return {
        status: "failed",
        stage: "target-refresh",
        reason: queueResult.reason,
        workflowId: active.workflowId,
      };
    }

    const attempt = (pendingTargetRefresh?.attempt ?? 0) + 1;
    const targetBranch = active.targetBranch;
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);
    targetRefreshInProgress = true;

    try {
      // Acquire serial Target-branch lease only as FIFO queue head.
      let heldLease = queueResult.queue.getHeldTargetBranchLease();
      if (!heldLease) {
        const acquired = await queueResult.queue.transition({
          kind: "acquire-phase",
          workflowCoordinatorLease,
          phase: "refresh",
        });
        if (!acquired.ok || !acquired.lease) {
          clearTargetRefreshState();
          return {
            status: "failed",
            stage: "target-refresh",
            reason: acquired.ok
              ? "Target-branch lease acquisition did not return a lease."
              : acquired.reason,
            workflowId: active.workflowId,
            targetBranch,
          };
        }
        heldLease = acquired.lease;
      }

      let integrationWorkspace: { branchName: string; worktreePath: string };
      try {
        integrationWorkspace = await bound.workspace.ensureIntegrationWorkspace({
          workflowId: active.workflowId,
          baseRef: active.integrationBranch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedPending: PendingTargetRefresh = {
          workflowId: active.workflowId,
          attempt,
          targetBranch,
          integrationBranch: active.integrationBranch,
          integrationWorktreePath: "",
          ...(heldLease.generation !== undefined
            ? { targetLeaseGeneration: heldLease.generation }
            : {}),
        };
        pendingTargetRefresh = failedPending;
        return failTargetRefresh(bound, {
          failureKind: "transient",
          reason: TARGET_REFRESH_FAILURE_REASONS.mergeError,
          detail: `Failed to ensure Integration workspace: ${message}`,
        });
      }

      const pending: PendingTargetRefresh = {
        workflowId: active.workflowId,
        attempt,
        targetBranch,
        integrationBranch: integrationWorkspace.branchName,
        integrationWorktreePath: integrationWorkspace.worktreePath,
        ...(heldLease.generation !== undefined
          ? { targetLeaseGeneration: heldLease.generation }
          : {}),
      };
      pendingTargetRefresh = pending;

      const transcriptKey = targetRefreshTranscriptKey(pending);
      await bound.transcripts.append(transcriptKey, {
        type: "target-refresh-start",
        targetBranch,
        integrationBranch: integrationWorkspace.branchName,
        targetLeaseGeneration: heldLease.generation,
      });

      // Renew while merge runs so long local work does not drop the lane.
      await queueResult.queue.transition({ kind: "renew-held-target-lease" });

      const mergePhase = await mergeTargetIntoIntegration({
        workspace: bound.workspace,
        workflowId: active.workflowId,
        targetBranch,
        integrationBranch: integrationWorkspace.branchName,
        integrationWorktreePath: integrationWorkspace.worktreePath,
        ...(heldLease.generation !== undefined
          ? { targetLeaseGeneration: heldLease.generation }
          : {}),
      });

      if (mergePhase.status === "failed") {
        return failTargetRefresh(bound, {
          failureKind: mergePhase.failureKind,
          reason: mergePhase.failureReasonCode,
          detail: mergePhase.reason,
        });
      }

      if (mergePhase.status === "conflict") {
        pending.targetSha = mergePhase.conflict.targetSha;
        pending.conflict = mergePhase.conflict;
        pendingTargetRefresh = pending;
        await bound.transcripts.append(transcriptKey, {
          type: "target-refresh-conflict",
          reason: mergePhase.conflict.message,
          targetSha: mergePhase.conflict.targetSha,
        });
        targetRefreshInProgress = false;
        return launchTargetRefreshConflictWorker(
          bound,
          pending,
          mergePhase.conflict,
        );
      }

      pending.targetSha = mergePhase.targetSha;
      pendingTargetRefresh = pending;
      await bound.transcripts.append(transcriptKey, {
        type: "target-refresh-merged",
        targetSha: mergePhase.targetSha,
        mergeCommitSha: mergePhase.mergeCommitSha,
        alreadyUpToDate: mergePhase.alreadyUpToDate,
      });

      return await finishTargetRefreshAfterMerge(bound, pending);
    } finally {
      stopHeartbeat();
      targetRefreshInProgress = false;
    }
  }

  async function applyCiGate(
    bound: RootScopedPorts,
    input: {
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      branchName: string;
      worktreePath: string;
      integrationBranch: string;
      integrationWorktreePath?: string;
      localVerification?: { ok: true; commands: readonly string[] };
      pushedBranches?: readonly string[];
      rePush: boolean;
    },
  ): Promise<StageResult> {
    const transcriptKey = {
      workflowId: input.workflowId,
      ticketNumber: input.ticketNumber,
      attempt: input.attempt,
    };

    if (input.rePush) {
      const active = await loadActiveWorkflow(bound, { force: true });
      if (!active || active.workflowId !== input.workflowId) {
        return {
          status: "failed",
          stage: "ci-gate",
          reason:
            "No bound Active workflow matches this CI retry. Recover Workflow-home routing before pushing.",
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          workflowId: input.workflowId,
        };
      }
      const authority = await ensureActiveWorkflowCoordinatorLease(bound, active);
      if (!authority.ok) {
        return {
          status: "failed",
          stage: "ci-gate",
          reason: authority.reason,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          workflowId: input.workflowId,
        };
      }
      try {
        await bound.remoteGit.pushBranch(input.integrationBranch);
        await bound.transcripts.append(transcriptKey, {
          type: "ci-retry-push",
          branchName: input.integrationBranch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `CI retry push of ${input.integrationBranch} failed: ${message}`;
        pendingCiRecovery = {
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          integrationBranch: input.integrationBranch,
          summary: reason,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "ci-check",
          status: "failure",
          summary: reason,
        });
        return {
          status: "needs-ci-recovery",
          stage: "ci-gate",
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          integrationBranch: input.integrationBranch,
          integrated: true,
          ciStatus: "failure",
          ticketClosed: false,
          recoveryOptions: [...CI_RECOVERY_OPTIONS],
          ciSummary: reason,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
        };
      }
    }

    const ci = await bound.ci.checkStatus({
      branchName: input.integrationBranch,
    });

    await bound.transcripts.append(transcriptKey, {
      type: "ci-check",
      status: ci.status,
      url: ci.url,
      summary: ci.summary,
    });

    if (ci.status === "success") {
      // Do not force-load the Active workflow or re-acquire the coordinator lease
      // on every green CI: that path hung Workflow #53/#56 after ci-check with no
      // ticket-closed (lease git thrash) while closeIssue never ran.
      clog("info", "ci-gate:green", {
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        summary: ci.summary,
      });

      let active: ActiveWorkflow | undefined =
        cachedPanelActive?.workflowId === input.workflowId
          ? cachedPanelActive
          : undefined;
      if (!active) {
        try {
          active = await loadActiveWorkflow(bound, { force: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          clog("warn", "ci-gate:load-active-failed", {
            workflowId: input.workflowId,
            ticketNumber: input.ticketNumber,
            reason: message,
          });
          return {
            status: "failed",
            stage: "ci-gate",
            reason: `CI is green but Active workflow could not be loaded to close #${input.ticketNumber}: ${message}`,
            ticketNumber: input.ticketNumber,
            attempt: input.attempt,
            workflowId: input.workflowId,
          };
        }
      }
      if (!active || active.workflowId !== input.workflowId) {
        return {
          status: "failed",
          stage: "ci-gate",
          reason:
            "No bound Active workflow matches this green CI result. Ticket closure is blocked until Workflow-home routing is recovered.",
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          workflowId: input.workflowId,
        };
      }

      if (active.coordination) {
        const alreadyHeld =
          heldWorkflowCoordinatorLease?.workflowId === input.workflowId &&
          !coordinatorLeaseLost;
        if (!alreadyHeld) {
          const authority = await ensureActiveWorkflowCoordinatorLease(
            bound,
            active,
          );
          if (!authority.ok) {
            clog("warn", "ci-gate:lease-failed", {
              workflowId: input.workflowId,
              ticketNumber: input.ticketNumber,
              reason: authority.reason,
            });
            return {
              status: "failed",
              stage: "ci-gate",
              reason: authority.reason,
              ticketNumber: input.ticketNumber,
              attempt: input.attempt,
              workflowId: input.workflowId,
            };
          }
        } else {
          // Keep the held lease warm without a full remote re-acquire dance.
          await heartbeatHeldWorkflowCoordinatorLease(bound);
          if (
            coordinatorLeaseLost ||
            heldWorkflowCoordinatorLease?.workflowId !== input.workflowId
          ) {
            const authority = await ensureActiveWorkflowCoordinatorLease(
              bound,
              active,
            );
            if (!authority.ok) {
              clog("warn", "ci-gate:lease-failed", {
                workflowId: input.workflowId,
                ticketNumber: input.ticketNumber,
                reason: authority.reason,
              });
              return {
                status: "failed",
                stage: "ci-gate",
                reason: authority.reason,
                ticketNumber: input.ticketNumber,
                attempt: input.attempt,
                workflowId: input.workflowId,
              };
            }
          }
        }
      }

      clog("info", "ci-gate:closing-ticket", {
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
      });
      try {
        await bound.tracker.closeIssue(input.ticketNumber);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `CI is green but closing #${input.ticketNumber} failed: ${message}`;
        clog("warn", "ci-gate:close-failed", {
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          reason: message,
        });
        pendingCiRecovery = {
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          integrationBranch: input.integrationBranch,
          ...(ci.url ? { url: ci.url } : {}),
          summary: reason,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "ticket-close-failed",
          reason,
        });
        return {
          status: "needs-ci-recovery",
          stage: "ci-gate",
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          integrationBranch: input.integrationBranch,
          integrated: true,
          ciStatus: "failure",
          ticketClosed: false,
          recoveryOptions: [...CI_RECOVERY_OPTIONS],
          ...(ci.url ? { ciUrl: ci.url } : {}),
          ciSummary: reason,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
        };
      }

      pendingCiRecovery = undefined;
      await bound.transcripts.append(transcriptKey, {
        type: "ticket-closed",
        ticketNumber: input.ticketNumber,
      });
      invalidatePanelCaches();
      clog("info", "ci-gate:ticket-closed", {
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
      });

      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        disposition: "close",
        integrated: true,
        integrationBranch: input.integrationBranch,
        ...(input.integrationWorktreePath
          ? { integrationWorktreePath: input.integrationWorktreePath }
          : {}),
        ...(input.localVerification
          ? { localVerification: input.localVerification }
          : {}),
        ...(input.pushedBranches ? { pushedBranches: input.pushedBranches } : {}),
        ciStatus: "success",
        ticketClosed: true,
        ...(ci.url ? { ciUrl: ci.url } : {}),
        ...(ci.summary ? { ciSummary: ci.summary } : {}),
        branchName: input.branchName,
        worktreePath: input.worktreePath,
      };
    }

    if (ci.status === "failure") {
      pendingCiRecovery = {
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        branchName: input.branchName,
        worktreePath: input.worktreePath,
        integrationBranch: input.integrationBranch,
        ...(ci.url ? { url: ci.url } : {}),
        ...(ci.summary ? { summary: ci.summary } : {}),
      };
      return {
        status: "needs-ci-recovery",
        stage: "ci-gate",
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        integrationBranch: input.integrationBranch,
        integrated: true,
        ciStatus: "failure",
        ticketClosed: false,
        recoveryOptions: [...CI_RECOVERY_OPTIONS],
        ...(ci.url ? { ciUrl: ci.url } : {}),
        ...(ci.summary ? { ciSummary: ci.summary } : {}),
        branchName: input.branchName,
        worktreePath: input.worktreePath,
      };
    }

    pendingCiRecovery = undefined;
    return {
      status: "pending-ci",
      stage: "ci-gate",
      workflowId: input.workflowId,
      ticketNumber: input.ticketNumber,
      attempt: input.attempt,
      integrationBranch: input.integrationBranch,
      integrated: true,
      ciStatus: "pending",
      ticketClosed: false,
      ...(input.integrationWorktreePath
        ? { integrationWorktreePath: input.integrationWorktreePath }
        : {}),
      ...(input.localVerification
        ? { localVerification: input.localVerification }
        : {}),
      ...(input.pushedBranches ? { pushedBranches: input.pushedBranches } : {}),
      ...(ci.url ? { ciUrl: ci.url } : {}),
      ...(ci.summary ? { ciSummary: ci.summary } : {}),
      branchName: input.branchName,
      worktreePath: input.worktreePath,
    };
  }

  async function resolveIntegratedTicket(
    bound: RootScopedPorts,
    ticketNumber: number,
  ): Promise<
    | {
        ok: true;
        active: ActiveWorkflow;
        integrated: IntegratedTicketRef;
        integrationBranch: string;
      }
    | { ok: false; reason: string }
  > {
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        ok: false,
        reason:
          "No Active workflow with published tickets. Recover Workflow state before checking CI.",
      };
    }
    const integrated = active.integratedTickets?.find(
      (t) => t.number === ticketNumber,
    );
    if (!integrated) {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} is not recorded as integrated on the Workflow manifest.`,
      };
    }
    const tickets = await bound.tracker.listTickets([ticketNumber]);
    const ticket = tickets.find((t) => t.number === ticketNumber);
    if (!ticket) {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} was not found on the tracker.`,
      };
    }
    if (ticket.state === "CLOSED") {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} is already closed.`,
      };
    }
    const integrationBranch =
      active.integrationBranch ?? integrationBranchName(active.workflowId);
    return { ok: true, active, integrated, integrationBranch };
  }

  async function runCiGateCheck(
    ticketNumber: number,
    options: { rePush: boolean },
  ): Promise<StageResult> {
    const bound = await requireScoped();
    const resolved = await resolveIntegratedTicket(bound, ticketNumber);
    if (!resolved.ok) {
      return {
        status: "failed",
        stage: "ci-gate",
        reason: resolved.reason,
        ticketNumber,
      };
    }

    return applyCiGate(bound, {
      workflowId: resolved.active.workflowId,
      ticketNumber,
      attempt: resolved.integrated.attempt,
      branchName: resolved.integrated.branchName,
      worktreePath: "",
      integrationBranch: resolved.integrationBranch,
      rePush: options.rePush,
    });
  }

  async function runCiRecovery(
    ticketNumber: number,
    decision: CiRecoveryDecision,
  ): Promise<StageResult> {
    if (!pendingCiRecovery || pendingCiRecovery.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "ci-gate",
        reason: `No pending CI recovery for #${ticketNumber}. Run Check CI first.`,
        ticketNumber,
      };
    }

    const current = pendingCiRecovery;
    const bound = await requireScoped();
    const transcriptKey = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
    };

    if (decision === "inspect") {
      await bound.transcripts.append(transcriptKey, {
        type: "ci-recovery",
        decision: "inspect",
        url: current.url,
        summary: current.summary,
      });
      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        integrated: true,
        integrationBranch: current.integrationBranch,
        ciStatus: "failure",
        ticketClosed: false,
        ...(current.url ? { ciUrl: current.url } : {}),
        ciSummary:
          current.summary ??
          current.url ??
          `CI failed for #${current.ticketNumber} on ${current.integrationBranch}.`,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    if (decision === "leave-open") {
      pendingCiRecovery = undefined;
      await bound.transcripts.append(transcriptKey, {
        type: "ci-recovery",
        decision: "leave-open",
      });
      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        disposition: "leave-open",
        integrated: true,
        integrationBranch: current.integrationBranch,
        ciStatus: "failure",
        ticketClosed: false,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    await bound.transcripts.append(transcriptKey, {
      type: "ci-recovery",
      decision: "retry",
    });
    return applyCiGate(bound, {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
      integrationBranch: current.integrationBranch,
      rePush: true,
    });
  }

  async function openWorkflowPr(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Open Workflow PR requires an Active workflow with published tickets that are all CI-complete.",
      };
    }
    if (active.workflowPr) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Workflow PR #${active.workflowPr.number} is already open. Use Merge Workflow PR.`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url ? { workflowPrUrl: active.workflowPr.url } : {}),
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress || !allTicketsComplete(progress)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "A Workflow PR is offered only after all tickets are integrated and CI-complete.",
        workflowId: active.workflowId,
      };
    }

    const ticketNumbers = active.tickets ?? [];
    const integrated = active.integratedTickets ?? [];
    const allIntegrated = ticketNumbers.every((n) =>
      integrated.some((t) => t.number === n),
    );
    if (!allIntegrated || !active.integrationBranch) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Cannot open a Workflow PR until every ticket has a successful Integration unit recorded on the Workflow manifest.",
        workflowId: active.workflowId,
      };
    }

    const prAuthority = await ensureActiveWorkflowCoordinatorLease(bound, active);
    if (!prAuthority.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: prAuthority.reason,
        workflowId: active.workflowId,
      };
    }

    const head = active.integrationBranch;
    const base = active.targetBranch;
    const title =
      active.title?.trim()
        ? `Workflow #${active.workflowId}: ${active.title.trim()}`
        : `Workflow #${active.workflowId}`;
    const body = [
      `Matt Auto Workflow PR for Workflow ID #${active.workflowId}.`,
      "",
      `Integration branch: \`${head}\``,
      `Target branch: \`${base}\``,
      "",
      "Tickets:",
      ...ticketNumbers.map((n) => `- #${n}`),
      "",
      "Opened by Matt Auto after all tickets integrated and CI-complete.",
    ].join("\n");

    // Coordination-aware delivery records PR freshness immediately so sibling
    // workflows never gate this PR's creation, and queue facts can attach.
    let mergeMethod: WorkflowMergeMethod | undefined;
    let headSha: string | undefined;
    if (active.coordination) {
      const method = await resolveRepositoryMergeMethod(bound, base);
      if (!method.ok) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: method.reason,
          workflowId: active.workflowId,
          integrationBranch: head,
          targetBranch: base,
        };
      }
      mergeMethod = method.mergeMethod;
      try {
        const integrationWorkspace =
          await bound.workspace.ensureIntegrationWorkspace({
            workflowId: active.workflowId,
            baseRef: head,
          });
        const ahead = await bound.workspace.hasCommitsAhead({
          worktreePath: integrationWorkspace.worktreePath,
          baseRef: base,
        });
        headSha = ahead.headSha;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: `Could not resolve Integration head SHA before opening Workflow PR: ${message}`,
          workflowId: active.workflowId,
          integrationBranch: head,
          targetBranch: base,
        };
      }
      if (!headSha) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason:
            "Could not resolve Integration head SHA before opening Workflow PR.",
          workflowId: active.workflowId,
          integrationBranch: head,
          targetBranch: base,
        };
      }
    }

    let pr: { number: number; url?: string };
    try {
      pr = await bound.tracker.createPullRequest({
        head,
        base,
        title,
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Failed to open Workflow PR from ${head} to ${base}: ${message}`,
        workflowId: active.workflowId,
        integrationBranch: head,
        targetBranch: base,
      };
    }

    const workflowPr = {
      number: pr.number,
      headBranch: head,
      baseBranch: base,
      ...(pr.url ? { url: pr.url } : {}),
    };
    let manifest = manifestFromActive(active, {
      stage: "pr-opened",
      workflowPr,
    });
    if (
      manifest.version === 2 &&
      mergeMethod &&
      headSha &&
      manifest.coordination
    ) {
      // With no required status checks, skip the awaiting-pr-checks stall and
      // admit refresh/merge eligibility immediately (still require Target refresh
      // to record validatedTargetSha before Merge).
      let queueCandidate: { state: "awaiting-pr-checks" } | {
        state: "merge-ready";
        mergeReadyAt: string;
      } = { state: "awaiting-pr-checks" };
      if (typeof bound.tracker.inspectProtectedBranchAutomation === "function") {
        try {
          const policy = await bound.tracker.inspectProtectedBranchAutomation({
            targetBranch: base,
          });
          if (!policyRequiresStatusChecks(policy)) {
            queueCandidate = {
              state: "merge-ready",
              mergeReadyAt: new Date().toISOString(),
            };
          }
        } catch {
          // Keep awaiting-pr-checks when policy cannot be observed.
        }
      }
      manifest = {
        ...manifest,
        coordination: {
          ...manifest.coordination,
          prFreshness: {
            headSha,
            mergeMethod,
          },
          queueCandidate,
        },
      };
    }

    const manifestAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!manifestAuthority.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: manifestAuthority.reason,
        workflowId: active.workflowId,
        workflowPrNumber: pr.number,
        ...(pr.url ? { workflowPrUrl: pr.url } : {}),
      };
    }

    try {
      await bound.tracker.writeWorkflowManifest(
        active.workflowId,
        manifestWithCoordinatorLeaseGeneration(manifest, manifestAuthority.lease),
      );
      invalidatePanelCaches();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Opened Workflow PR #${pr.number} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId}.`,
        workflowId: active.workflowId,
        workflowPrNumber: pr.number,
        ...(pr.url ? { workflowPrUrl: pr.url } : {}),
        integrationBranch: head,
        targetBranch: base,
      };
    }

    return {
      status: "completed",
      stage: "workflow-pr",
      workflowId: active.workflowId,
      workflowPrNumber: pr.number,
      ...(pr.url ? { workflowPrUrl: pr.url } : {}),
      integrationBranch: head,
      targetBranch: base,
    };
  }

  async function mergeWorkflowPr(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "pr-opened" || !active.workflowPr) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Merge Workflow PR requires an open Workflow PR on the Active workflow.",
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress || !allTicketsComplete(progress)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Cannot merge the Workflow PR while tickets remain open or awaiting CI. Finish or Rework tickets first.",
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
      };
    }

    // Repository merge policy, stale-base guarantees, and non-interactive
    // authority are intentionally checked only at the automatic merge boundary.
    const automaticMergeReadiness = await requireAutomaticMergeReadiness(
      bound,
      active.targetBranch,
    );
    if (!automaticMergeReadiness.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: automaticMergeReadiness.reason,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    const preMergeAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!preMergeAuthority.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: preMergeAuthority.reason,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    // Dual-root: publish + re-check submodule pointers before merge (#30).
    const stopHeartbeat = startWorkflowCoordinatorHeartbeat(bound);
    try {
      const targetBranch = await resolveTargetBranch(
        bound.preferences,
        bound.environment,
      );
      const integrationWorkspace =
        await bound.workspace.ensureIntegrationWorkspace({
          workflowId: active.workflowId,
          baseRef: active.integrationBranch ?? targetBranch,
        });
      const submoduleGate = await ensureSubmoduleGitlinksPublished(
        integrationWorkspace.worktreePath,
      );
      if (!submoduleGate.ok) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: `Cannot merge Workflow PR #${active.workflowPr.number}: ${submoduleGate.reason}`,
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
          ...(active.workflowPr.url
            ? { workflowPrUrl: active.workflowPr.url }
            : {}),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Cannot merge Workflow PR #${active.workflowPr.number}: submodule gate failed to run: ${message}`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    } finally {
      stopHeartbeat();
    }

    const mergeAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!mergeAuthority.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: mergeAuthority.reason,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }
    if (active.coordination && !mergeAuthority.lease) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Workflow coordinator lease is unavailable for Workflow PR merge.",
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    // Resolve repository-configured merge method — never hard-code a strategy.
    const mergeMethodResult = await resolveRepositoryMergeMethod(
      bound,
      active.targetBranch,
    );
    let mergeMethod: WorkflowMergeMethod | undefined =
      active.coordination?.prFreshness?.mergeMethod;
    if (!mergeMethod) {
      if (!mergeMethodResult.ok) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: mergeMethodResult.reason,
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
          ...(active.workflowPr.url
            ? { workflowPrUrl: active.workflowPr.url }
            : {}),
        };
      }
      mergeMethod = mergeMethodResult.mergeMethod;
    }

    // Coordination-aware automatic merge: Target-branch lease + freshness preflight.
    let heldTargetLease: TargetBranchLease | undefined;
    let expectedHeadSha: string | undefined =
      active.coordination?.prFreshness?.headSha;
    let expectedTargetSha: string | undefined =
      active.coordination?.prFreshness?.validatedTargetSha;
    let queue: TargetBranchQueueOrchestrator | undefined;

    if (active.coordination) {
      if (!active.coordination.prFreshness) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason:
            "Cannot merge a coordination-aware Workflow PR without recorded PR freshness facts.",
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
        };
      }
      if (!expectedTargetSha) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason:
            "Cannot merge until the Workflow PR head has been refreshed against a validated Target SHA. Run Target-branch refresh first.",
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
        };
      }

      const queueResult = await ensureTargetDeliveryQueue(bound, active);
      if (!queueResult.ok) {
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: queueResult.reason,
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
        };
      }
      queue = queueResult.queue;

      const workflowCoordinatorLease = mergeAuthority.lease!;

      heldTargetLease = queue.getHeldTargetBranchLease();
      if (!heldTargetLease) {
        const acquired = await queue.transition({
          kind: "acquire-phase",
          workflowCoordinatorLease,
          phase: "merge",
        });
        if (!acquired.ok || !acquired.lease) {
          return {
            status: "failed",
            stage: "workflow-pr",
            reason: acquired.ok
              ? "Target-branch lease acquisition did not return a lease."
              : acquired.reason,
            workflowId: active.workflowId,
            workflowPrNumber: active.workflowPr.number,
          };
        }
        heldTargetLease = acquired.lease;
      }

      // Observe live PR head + Target tip and required checks for that head.
      if (typeof bound.tracker.getPullRequestFreshness !== "function") {
        await queue.transition({ kind: "release-held-target-lease" });
        return {
          status: "failed",
          stage: "workflow-pr",
          reason:
            "Pull request freshness observation is unavailable; refusing automatic merge.",
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
        };
      }

      let livePr: { headSha: string; baseSha: string };
      try {
        livePr = await bound.tracker.getPullRequestFreshness({
          number: active.workflowPr.number,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await queue.transition({
          kind: "record-failure",
          workflowCoordinatorLease,
          failureKind: "transient",
          reason: `pr-freshness-observation-failed:${message}`,
        });
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: `Could not observe Workflow PR freshness before merge: ${message}`,
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
        };
      }

      // Optional/non-required CI must not stall merge when Target policy has no
      // required status checks (billing-blocked runners, informational Actions).
      let requireStatusChecks = true;
      if (typeof bound.tracker.inspectProtectedBranchAutomation === "function") {
        try {
          const policy = await bound.tracker.inspectProtectedBranchAutomation({
            targetBranch: active.targetBranch,
          });
          requireStatusChecks = policyRequiresStatusChecks(policy);
        } catch {
          // Fail closed: if policy cannot be observed, keep required-check gate.
          requireStatusChecks = true;
        }
      }

      const ci = requireStatusChecks
        ? await bound.ci.checkStatus({
            branchName: active.workflowPr.headBranch,
          })
        : {
            status: "success" as const,
            summary: "No required status checks on Target branch.",
          };

      const freshness = evaluateMergeFreshness({
        heldLease: heldTargetLease,
        expectedGeneration: heldTargetLease.generation,
        expectedHolderId: heldTargetLease.holderId,
        validatedTargetSha: expectedTargetSha,
        currentTargetSha: livePr.baseSha,
        expectedHeadSha: expectedHeadSha!,
        currentHeadSha: livePr.headSha,
        requiredChecks: {
          headSha: livePr.headSha,
          status: ci.status,
        },
        requireStatusChecks,
      });

      if (!freshness.ok) {
        // Stale target → requeue for refresh; other failures record retry outcomes.
        if (freshness.recovery === "requeue-refresh") {
          await queue.transition({
            kind: "record-failure",
            workflowCoordinatorLease,
            failureKind: freshness.failureKind,
            reason: freshness.code,
          });
        } else if (freshness.recovery === "awaiting-pr-checks") {
          // Release the lane and return to awaiting checks without a deterministic failure.
          await queue.transition({
            kind: "release-for-pr-checks",
            workflowCoordinatorLease,
          });
        } else {
          await queue.transition({
            kind: "record-failure",
            workflowCoordinatorLease,
            failureKind: freshness.failureKind,
            reason: freshness.code,
          });
        }
        return {
          status: "failed",
          stage: "workflow-pr",
          reason: freshness.reason,
          workflowId: active.workflowId,
          workflowPrNumber: active.workflowPr.number,
          ...(active.workflowPr.url
            ? { workflowPrUrl: active.workflowPr.url }
            : {}),
        };
      }

      // Live head may have advanced only if it still matches expected; keep it.
      expectedHeadSha = livePr.headSha;
      expectedTargetSha = livePr.baseSha;
    }

    try {
      await bound.tracker.mergePullRequest({
        number: active.workflowPr.number,
        mergeMethod,
        ...(expectedHeadSha ? { expectedHeadSha } : {}),
        ...(expectedTargetSha ? { expectedTargetSha } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (queue && mergeAuthority.lease) {
        await queue.transition({
          kind: "record-failure",
          workflowCoordinatorLease: mergeAuthority.lease,
          failureKind: "transient",
          reason: `merge-failed:${message}`,
        });
      }
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Failed to merge Workflow PR #${active.workflowPr.number}: ${message}`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    if (queue && mergeAuthority.lease && active.coordination) {
      const marked = await queue.transition({
        kind: "mark-merged",
        workflowCoordinatorLease: mergeAuthority.lease,
      });
      if (!marked.ok) {
        // PR is already merged on GitHub; surface the queue persistence problem
        // but still try to write the local merged stage below.
      }
    }

    const manifest = manifestFromActive(active, { stage: "merged" });
    const manifestAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!manifestAuthority.ok) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: manifestAuthority.reason,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }
    try {
      await bound.tracker.writeWorkflowManifest(
        active.workflowId,
        manifestWithCoordinatorLeaseGeneration(manifest, manifestAuthority.lease),
      );
      invalidatePanelCaches();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Merged Workflow PR #${active.workflowPr.number} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId} before cleanup.`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    return {
      status: "completed",
      stage: "workflow-pr",
      workflowId: active.workflowId,
      workflowPrNumber: active.workflowPr.number,
      ...(active.workflowPr.url
        ? { workflowPrUrl: active.workflowPr.url }
        : {}),
      ...(active.integrationBranch
        ? { integrationBranch: active.integrationBranch }
        : {}),
      targetBranch: active.targetBranch,
    };
  }

  async function cleanupWorkflow(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "merged") {
      return {
        status: "failed",
        stage: "cleanup",
        reason:
          "Workflow cleanup runs after the Workflow PR merges. Merge the Workflow PR first.",
      };
    }

    const cleanupAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!cleanupAuthority.ok) {
      return {
        status: "failed",
        stage: "cleanup",
        reason: cleanupAuthority.reason,
        workflowId: active.workflowId,
      };
    }

    await recoverCompletedWorkerTelemetryFromTranscripts(bound, active);

    const branches = await bound.workspace.listWorkflowBranches(
      active.workflowId,
    );

    let removedLocalBranches: readonly string[] = [];
    try {
      const local = await bound.workspace.cleanupWorkflowWorkspaces(
        active.workflowId,
      );
      removedLocalBranches = local.removedLocalBranches;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Local workspace cleanup failed: ${message}`,
        workflowId: active.workflowId,
      };
    }

    // Pair remote cleanup with local — same branch set (local list + any already-known).
    // Always re-filter to this Workflow ID's namespace so a corrupt manifest or
    // stray branch name can never delete a sibling workflow's branches.
    const remoteBranches = filterWorkflowOwnedBranches(active.workflowId, [
      ...branches,
      ...removedLocalBranches,
      ...(active.integrationBranch ? [active.integrationBranch] : []),
      ...(active.integratedTickets ?? []).map((t) => t.branchName),
    ]);

    const remoteCleanupAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!remoteCleanupAuthority.ok) {
      return {
        status: "failed",
        stage: "cleanup",
        reason: remoteCleanupAuthority.reason,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: false,
      };
    }

    try {
      await bound.remoteGit.deleteRemoteBranches(remoteBranches);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Remote matt-auto branch cleanup failed after local cleanup: ${message}. Retry Cleanup to finish paired remote removal.`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: false,
      };
    }

    try {
      await bound.transcripts.cleanupWorkflowTranscripts(active.workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Transcript cleanup failed after local/remote branch cleanup: ${message}`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: true,
      };
    }

    // Retain GitHub issue/PR/manifest history — only mark completed.
    const manifest = manifestFromActive(active, { stage: "completed" });
    const completionAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!completionAuthority.ok) {
      return {
        status: "failed",
        stage: "cleanup",
        reason: completionAuthority.reason,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: true,
      };
    }
    try {
      await bound.tracker.writeWorkflowManifest(
        active.workflowId,
        manifestWithCoordinatorLeaseGeneration(manifest, completionAuthority.lease),
      );
      invalidatePanelCaches();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Cleaned local/remote artifacts but writing the completed Workflow manifest failed: ${message}`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: true,
      };
    }

    lastCompletedWorkflow = {
      workflowId: active.workflowId,
      targetBranch: active.targetBranch,
      ...(active.title ? { title: active.title } : {}),
    };
    // Keep a coordination-aware binding through the parent issue close below:
    // every remaining remote cleanup mutation must still prove lease ownership.
    if (!active.coordination) {
      await bound.preferences.clearActiveWorkflowId(active.targetBranch);
    }
    invalidatePanelCaches();

    // Safe local pull of target branch when worktree allows (FF-only).
    // Soft-skip dirty/wrong-branch/non-FF — never fail cleanup over pull.
    let localPull:
      | {
          pulled: boolean;
          skipped?: boolean;
          branch: string;
          reason?: string;
          submodulesUpdated?: boolean;
        }
      | undefined;
    try {
      const pull = await bound.remoteGit.safePullBranch(active.targetBranch);
      if (pull.ok && pull.pulled) {
        localPull = {
          pulled: true,
          branch: pull.branch,
          ...(pull.submodulesUpdated !== undefined
            ? { submodulesUpdated: pull.submodulesUpdated }
            : {}),
        };
      } else if (pull.ok && !pull.pulled) {
        localPull = {
          pulled: false,
          skipped: true,
          branch: pull.branch,
          reason: pull.reason,
        };
      } else {
        localPull = {
          pulled: false,
          skipped: true,
          branch: pull.branch,
          reason: pull.reason,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      localPull = {
        pulled: false,
        skipped: true,
        branch: active.targetBranch,
        reason: message,
      };
    }

    // Soft hygiene (issue #31): prune worktrees; delete remote matt-auto/gitlink/*
    // only when the tip is already on the submodule mainline. Never fails cleanup.
    let gitlinkGc:
      | {
          deletedRemoteRefs: readonly string[];
          keptRemoteRefs: readonly string[];
          deletedLocalBranches: readonly string[];
          worktreePruned: boolean;
          errors: readonly string[];
        }
      | undefined;
    const gitlinkAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!gitlinkAuthority.ok) {
      gitlinkGc = {
        deletedRemoteRefs: [],
        keptRemoteRefs: [],
        deletedLocalBranches: [],
        worktreePruned: false,
        errors: [gitlinkAuthority.reason],
      };
    } else {
      try {
        const rootPath = selectedPath ?? ports.startPath;
        gitlinkGc = await gcMattAutoGitlinkArtifacts(rootPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        gitlinkGc = {
          deletedRemoteRefs: [],
          keptRemoteRefs: [],
          deletedLocalBranches: [],
          worktreePruned: false,
          errors: [message],
        };
      }
    }

    // Close parent Workflow spec (Workflow ID) — part of delivery completion.
    // Soft-fail: artifacts are already gone; do not fail cleanup if close fails.
    let parentSpecClosed = false;
    let parentSpecCloseWarning: string | undefined;
    const pullLine = localPull?.pulled
      ? `Workflow root fast-forwarded to origin/${localPull.branch}${localPull.submodulesUpdated ? " (submodules updated)" : ""}. Please /reload Pi to pick up the merged work.`
      : localPull?.skipped
        ? `Auto-pull skipped (${localPull.reason ?? "unsafe"}). Please \`git pull\` on the Workflow root and /reload Pi when ready.`
        : "Please `git pull` on the Workflow root and `/reload` Pi so your session picks up the merged work.";
    const gcLine =
      gitlinkGc &&
      (gitlinkGc.deletedRemoteRefs.length > 0 ||
        gitlinkGc.deletedLocalBranches.length > 0 ||
        gitlinkGc.keptRemoteRefs.length > 0)
        ? [
            `Gitlink hygiene: deleted ${gitlinkGc.deletedRemoteRefs.length} remote matt-auto/gitlink/* ref(s) already on mainline`,
            gitlinkGc.keptRemoteRefs.length > 0
              ? `(kept ${gitlinkGc.keptRemoteRefs.length} tip(s) not yet on mainline)`
              : undefined,
            gitlinkGc.deletedLocalBranches.length > 0
              ? `; removed local ${gitlinkGc.deletedLocalBranches.join(", ")}`
              : undefined,
            ".",
          ]
            .filter(Boolean)
            .join(" ")
        : undefined;
    const closeComment = [
      `Workflow #${active.workflowId} cleanup completed.`,
      active.workflowPr
        ? `Workflow PR #${active.workflowPr.number}${active.workflowPr.url ? ` (${active.workflowPr.url})` : ""} merged; local workspaces/transcripts and remote matt-auto branches removed.`
        : `Local workspaces/transcripts and remote matt-auto branches removed.`,
      pullLine,
      ...(gcLine ? [gcLine] : []),
    ].join("\n\n");
    const closeAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!closeAuthority.ok) {
      parentSpecClosed = false;
      parentSpecCloseWarning = closeAuthority.reason;
    } else {
      try {
        await bound.tracker.closeIssue(active.workflowId, {
          comment: closeComment,
        });
        parentSpecClosed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parentSpecClosed = false;
        parentSpecCloseWarning = message;
      }
    }

    if (active.coordination) {
      try {
        await clearWorkflowHomeBinding(bound, active.coordination.target);
      } catch {
        // GitHub state is already completed; a stale local pointer routes back
        // through explicit selection on the next Workflow-home open.
      }
    }
    // Release only this home's held capacity and Target-branch lease. Shared
    // repository worker-capacity policy and sibling leases/slots stay intact.
    await releaseAllHeldWorkerSlots(bound);
    if (active.coordination) {
      await releaseBoundTargetBranchLease(bound, active.coordination.target);
    }
    await releaseHeldWorkflowCoordinatorLease(bound);
    invalidatePanelCaches();

    return {
      status: "completed",
      stage: "cleanup",
      workflowId: active.workflowId,
      removedBranches: remoteBranches,
      cleanedLocal: true,
      cleanedRemote: true,
      parentSpecClosed,
      ...(parentSpecCloseWarning
        ? { parentSpecCloseWarning }
        : {}),
      ...(localPull ? { localPull } : {}),
      ...(gitlinkGc ? { gitlinkGc } : {}),
      ...(active.workflowPr
        ? {
            workflowPrNumber: active.workflowPr.number,
            ...(active.workflowPr.url
              ? { workflowPrUrl: active.workflowPr.url }
              : {}),
          }
        : {}),
      targetBranch: active.targetBranch,
      ...(active.integrationBranch
        ? { integrationBranch: active.integrationBranch }
        : {}),
    };
  }

  async function startFollowUpWorkflow(): Promise<StageResult> {
    const bound = await requireScoped();
    const route = await loadWorkflowHomeRoute(bound, { force: true });
    if (route.kind === "legacy" || route.kind === "bound") {
      const active = route.active;
      if (active) {
        return {
          status: "failed",
          stage: "follow-up",
          reason: `An Active workflow already exists for Target branch "${active.targetBranch}" (Workflow ID #${active.workflowId}). Finish or clean it up before starting a Follow-up workflow.`,
        };
      }
    }
    if (route.kind === "lease-held") {
      return {
        status: "failed",
        stage: "follow-up",
        reason: `Workflow #${route.active.workflowId} remains bound to this checkout, but its coordinator lease is held by another Workflow home. Resume it explicitly after that lease is released.`,
        workflowId: route.active.workflowId,
      };
    }
    if (route.kind === "unavailable") {
      return {
        status: "failed",
        stage: "follow-up",
        reason: route.reason,
      };
    }

    const targetBranch = await resolveTargetBranch(bound.preferences, bound.environment);
    if (
      !lastCompletedWorkflow ||
      lastCompletedWorkflow.targetBranch !== targetBranch
    ) {
      return {
        status: "failed",
        stage: "follow-up",
        reason:
          "Start Follow-up workflow requires a completed Workflow on this Target branch (after Workflow PR merge and cleanup).",
      };
    }

    const original = lastCompletedWorkflow;
    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "follow-up",
        reason:
          "Cannot start a Follow-up workflow without a Worker profile. Configure a Worker profile first.",
      };
    }

    const title = original.title?.trim()
      ? `Follow-up: ${original.title.trim()}`
      : `Follow-up of Workflow #${original.workflowId}`;
    const body = [
      `## Follow-up workflow`,
      "",
      `This Follow-up workflow references completed Workflow #${original.workflowId} rather than mutating it.`,
      "",
      `Original Workflow ID: #${original.workflowId}`,
      `Target branch: \`${original.targetBranch}\``,
      "",
      "## What to build",
      "",
      "Describe the post-merge rework for this Follow-up workflow.",
    ].join("\n");

    const routing = await resolveCoordinationRoutingContext(bound);
    if (routing.supported && !routing.ok) {
      return {
        status: "failed",
        stage: "follow-up",
        reason: routing.reason,
        followUpOf: original.workflowId,
      };
    }
    if (routing.supported) {
      const local = await ensureWorkflowHomeLock(bound);
      if (!local.ok) {
        return {
          status: "failed",
          stage: "follow-up",
          reason: local.reason,
          followUpOf: original.workflowId,
        };
      }
    }

    let created: { number: number };
    try {
      created = await bound.tracker.createIssue({
        title,
        body,
        labels: [SPEC_ISSUE_LABEL],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "follow-up",
        reason: `Failed to create Follow-up spec issue: ${message}`,
        followUpOf: original.workflowId,
      };
    }

    let coordinatorLease: WorkflowCoordinatorLease | undefined;
    if (routing.supported && routing.ok) {
      const lease = await ensureWorkflowCoordinatorLease(
        bound,
        routing.target,
        created.number,
      );
      if (!lease.ok) {
        return {
          status: "failed",
          stage: "follow-up",
          reason: `Follow-up issue #${created.number} was created, but its Workflow coordinator lease could not be acquired: ${lease.reason}`,
          workflowId: created.number,
          followUpOf: original.workflowId,
        };
      }
      coordinatorLease = lease.lease;
    }

    const manifest: WorkflowManifest =
      routing.supported && routing.ok && coordinatorLease
        ? {
            schema: WORKFLOW_MANIFEST_SCHEMA,
            version: 2,
            workflowId: created.number,
            targetBranch,
            stage: "spec-published",
            workerProfile: workerProfile.profile,
            followUpOf: original.workflowId,
            coordination: {
              target: copyCanonicalTarget(routing.target),
              observedLeaseGenerations: {
                workflowCoordinator: coordinatorLease.generation,
              },
            },
          }
        : {
            schema: WORKFLOW_MANIFEST_SCHEMA,
            version: 1,
            workflowId: created.number,
            targetBranch,
            stage: "spec-published",
            workerProfile: workerProfile.profile,
            followUpOf: original.workflowId,
          };

    try {
      await bound.tracker.writeWorkflowManifest(created.number, manifest);
      if (routing.supported && routing.ok) {
        await persistWorkflowHomeBinding(bound, routing.target, created.number);
      } else {
        await bound.preferences.setActiveWorkflowId(targetBranch, created.number);
      }
      invalidatePanelCaches();
    } catch (error) {
      if (routing.supported) {
        await releaseHeldWorkflowCoordinatorLease(bound);
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "follow-up",
        reason: `Created Follow-up issue #${created.number} but writing the Workflow manifest or local binding failed: ${message}`,
        workflowId: created.number,
        followUpOf: original.workflowId,
      };
    }

    // One Active workflow per Target branch — clear the completed pointer once followed up.
    lastCompletedWorkflow = undefined;

    return {
      status: "completed",
      stage: "follow-up",
      workflowId: created.number,
      followUpOf: original.workflowId,
      targetBranch,
    };
  }

  async function startRework(ticketNumber: number): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "rework",
        reason:
          "Pre-merge Rework requires an Active workflow before the Workflow PR merges.",
        ticketNumber,
      };
    }

    if (active.stage === "merged") {
      return {
        status: "failed",
        stage: "rework",
        reason:
          "Post-merge rework creates a Follow-up workflow with a new spec issue rather than mutating the completed workflow.",
        ticketNumber,
      };
    }

    // Rework uses the same workflow-local P1 gate as Implement before it
    // reopens a ticket. Coordination-aware capacity itself is leased only by
    // the eventual fresh Implementation process after the ticket is ready.
    const launchBlock = await blockNewImplementationLaunch(
      bound,
      ticketNumber,
      "rework",
      active,
    );
    if (launchBlock) return launchBlock;

    const reworkAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!reworkAuthority.ok) {
      return {
        status: "failed",
        stage: "rework",
        reason: reworkAuthority.reason,
        ticketNumber,
        workflowId: active.workflowId,
      };
    }

    const integrated = (active.integratedTickets ?? []).find(
      (t) => t.number === ticketNumber,
    );
    if (!integrated) {
      return {
        status: "failed",
        stage: "rework",
        reason: `Ticket #${ticketNumber} is not recorded as integrated. Use Implement for open ready tickets, or complete Integration first.`,
        ticketNumber,
      };
    }

    const tickets = await bound.tracker.listTickets([ticketNumber]);
    const ticket = tickets.find((t) => t.number === ticketNumber);
    if (!ticket) {
      return {
        status: "failed",
        stage: "rework",
        reason: `Ticket #${ticketNumber} was not found on the tracker.`,
        ticketNumber,
      };
    }

    if (ticket.state === "CLOSED") {
      const reopenAuthority = await ensureActiveWorkflowCoordinatorLease(
        bound,
        active,
      );
      if (!reopenAuthority.ok) {
        return {
          status: "failed",
          stage: "rework",
          reason: reopenAuthority.reason,
          ticketNumber,
          workflowId: active.workflowId,
        };
      }
      try {
        await bound.tracker.reopenIssue(ticketNumber);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          stage: "rework",
          reason: `Failed to reopen #${ticketNumber} for Rework: ${message}`,
          ticketNumber,
        };
      }
    }

    // Drop from integrated list so the frontier and Workflow PR gates re-evaluate.
    const remainingIntegrated = (active.integratedTickets ?? []).filter(
      (t) => t.number !== ticketNumber,
    );
    const manifest = manifestFromActive(active, {
      // Keep pr-opened if a Workflow PR already exists; otherwise stay on tickets-published.
      stage: active.workflowPr ? "pr-opened" : "tickets-published",
      integratedTickets: remainingIntegrated,
    });

    const manifestAuthority = await ensureActiveWorkflowCoordinatorLease(
      bound,
      active,
    );
    if (!manifestAuthority.ok) {
      return {
        status: "failed",
        stage: "rework",
        reason: manifestAuthority.reason,
        ticketNumber,
        workflowId: active.workflowId,
      };
    }
    try {
      await bound.tracker.writeWorkflowManifest(
        active.workflowId,
        manifestWithCoordinatorLeaseGeneration(manifest, manifestAuthority.lease),
      );
      invalidatePanelCaches();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "rework",
        reason: `Reopened #${ticketNumber} but updating the Workflow manifest failed: ${message}`,
        ticketNumber,
        workflowId: active.workflowId,
      };
    }

    // Dependents may already be running if they were launched while this ticket
    // was briefly closed. Abort them before opening the rework Implementation.
    await reconcileBlockedRunningWorkers();

    // Fresh numbered attempt workspace + Implementation worker (does not reuse completed workspace).
    return startImplementation(ticketNumber);
  }

  /**
   * Abort running Implementation workers whose tickets are on the blocked
   * frontier (open blockers). Used after Rework reopens an upstream ticket and
   * periodically during the wait surface.
   */
  async function reconcileBlockedRunningWorkers(): Promise<{
    abortedWorkerCount: number;
    affectedAttempts: readonly PipelineAffectedAttempt[];
  }> {
    const running = [...activeImplementationWorkers.values()].filter(
      (w) => w.status === "running",
    );
    if (running.length === 0) {
      return { abortedWorkerCount: 0, affectedAttempts: [] };
    }

    const bound = scoped ?? (await requireScoped());
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return { abortedWorkerCount: 0, affectedAttempts: [] };
    }

    const progress = await loadTicketProgress(bound, active, { force: true });
    if (!progress || progress.blocked.length === 0) {
      return { abortedWorkerCount: 0, affectedAttempts: [] };
    }

    const toAbort = new Set(
      runningTicketsBlockedByOpen(
        running.map((w) => w.ticketNumber),
        progress.blocked,
      ),
    );
    if (toAbort.size === 0) {
      return { abortedWorkerCount: 0, affectedAttempts: [] };
    }

    const affected: PipelineAffectedAttempt[] = [];
    for (const worker of running) {
      if (!toAbort.has(worker.ticketNumber)) continue;
      const openBlockers =
        progress.blocked.find((b) => b.number === worker.ticketNumber)
          ?.openBlockers ?? [];
      try {
        await bound.workers.abort(worker.workerId);
      } catch {
        // Best-effort; still drop session state so the run loop does not wait.
      }
      await releaseHeldWorkerSlot(bound, worker.workerId);
      worker.status = "aborted";
      activeImplementationWorkers.delete(worker.workerId);
      // Cooldown so auto-advance does not immediately re-pick a still-blocked ticket.
      rememberImplementationRecovery(
        worker.ticketNumber,
        "Worker aborted because the ticket became blocked again.",
      );
      await bound.transcripts.append(
        {
          workflowId: worker.workflowId,
          ticketNumber: worker.ticketNumber,
          attempt: worker.attempt,
        },
        {
          type: "worker-aborted",
          reason: "open-blockers",
          openBlockers,
        },
      );
      affected.push({
        workflowId: worker.workflowId,
        ticketNumber: worker.ticketNumber,
        attempt: worker.attempt,
        kind: "implementation",
      });
    }

    if (affected.length > 0) {
      invalidatePanelCaches();
    }
    return { abortedWorkerCount: affected.length, affectedAttempts: affected };
  }

  /**
   * Abort session-owned Implementation + Conflict resolution workers.
   * @param setCooldown - when true (session teardown), block auto re-launch briefly.
   * @param transcriptEvent - structured event appended to each affected attempt.
   */
  async function abortSessionWorkers(options: {
    setCooldown: boolean;
    transcriptEvent: Record<string, unknown>;
    preservePendingIntegrationMessage?: string;
  }): Promise<PipelineAffectedAttempt[]> {
    const bound = scoped ?? (await requireScoped());
    // Abort live Implementation workers. Completed workers waiting for the
    // single pendingDisposition slot keep their Stage results (same as
    // pendingDisposition itself, which is never cleared here).
    const runningWorkers = [...activeImplementationWorkers.values()].filter(
      (w) => w.status === "running",
    );
    const conflictWorker = activeConflictWorker;
    const affected: PipelineAffectedAttempt[] = [];

    for (const worker of runningWorkers) {
      affected.push({
        workflowId: worker.workflowId,
        ticketNumber: worker.ticketNumber,
        attempt: worker.attempt,
        kind: "implementation",
      });
    }
    if (conflictWorker) {
      affected.push({
        workflowId: conflictWorker.workflowId,
        ticketNumber: conflictWorker.ticketNumber,
        attempt: conflictWorker.attempt,
        kind: "conflict-resolution",
      });
    }

    try {
      await bound.workers.abortAll();
    } catch {
      // Best-effort abort; session teardown still clears local worker state.
    }

    for (const worker of runningWorkers) {
      await releaseHeldWorkerSlot(bound, worker.workerId);
      worker.status = "aborted";
      activeImplementationWorkers.delete(worker.workerId);
      if (options.setCooldown) {
        // Prevent the pipeline from immediately re-selecting the same ticket.
        rememberImplementationRecovery(
          worker.ticketNumber,
          "Worker aborted by pipeline pause or run termination.",
        );
      }
      await bound.transcripts.append(
        {
          workflowId: worker.workflowId,
          ticketNumber: worker.ticketNumber,
          attempt: worker.attempt,
        },
        options.transcriptEvent,
      );
    }

    if (conflictWorker) {
      conflictWorker.status = "aborted";
      await bound.transcripts.append(
        {
          workflowId: conflictWorker.workflowId,
          ticketNumber: conflictWorker.ticketNumber,
          attempt: conflictWorker.attempt,
        },
        options.transcriptEvent,
      );
      if (conflictWorker.resolutionKind === "target-refresh") {
        if (
          pendingTargetRefresh &&
          pendingTargetRefresh.workflowId === conflictWorker.workflowId
        ) {
          pendingTargetRefresh.lastFailure =
            options.preservePendingIntegrationMessage ??
            "Target-refresh Conflict resolution worker aborted. Target-branch lease is released; refresh can be retried when merge-ready again.";
        }
      } else if (
        pendingIntegration &&
        pendingIntegration.ticketNumber === conflictWorker.ticketNumber
      ) {
        pendingIntegration.lastFailure =
          options.preservePendingIntegrationMessage ??
          "Conflict resolution worker aborted with Workflow home. In-progress merge is preserved for retry.";
      }
    }

    activeConflictWorker = undefined;

    // Pause / Terminate release only this workflow's Target-branch lease so
    // sibling workflows can continue delivery on the shared Target lane.
    if (targetDeliveryQueue) {
      try {
        await targetDeliveryQueue.transition({
          kind: "release-held-target-lease",
        });
      } catch {
        // Best-effort; TTL reclaim remains the fail-closed backstop.
      }
      targetDeliveryQueue = undefined;
    }
    if (pendingTargetRefresh && !pendingTargetRefresh.conflict) {
      // Non-conflict refresh mid-flight cannot safely resume with a dropped lease.
      pendingTargetRefresh = undefined;
      targetRefreshInProgress = false;
    } else {
      targetRefreshInProgress = false;
    }

    return affected;
  }

  async function abortWorkers(): Promise<void> {
    await abortSessionWorkers({
      setCooldown: true,
      transcriptEvent: { type: "worker-aborted" },
    });
  }

  async function releaseWorkflowHome(): Promise<void> {
    const bound = scoped;
    // Callers normally abort first, but never release capacity underneath a
    // still-running session worker when releaseWorkflowHome is used directly.
    if (bound && heldWorkerSlots.size > 0) {
      await abortWorkers();
    }
    await releaseAllHeldWorkerSlots(bound);
    await releaseHeldWorkflowCoordinatorLease(bound);
    const lock = heldWorkflowHomeLock;
    heldWorkflowHomeLock = undefined;
    lastWorkflowHomeLockHeartbeatAtMs = 0;
    if (!lock || !bound?.workflowHomeLock) return;
    try {
      await bound.workflowHomeLock.release(lock);
    } catch {
      // The local lock has a stale-owner recovery path; never turn session
      // shutdown into a failure because its best-effort release could not run.
    }
  }

  function isPipelinePaused(): boolean {
    return pipelinePaused;
  }

  function isRunTerminated(): boolean {
    return runTerminated;
  }

  function isAutoAdvanceBlocked(): boolean {
    return pipelinePaused || runTerminated;
  }

  function beginPipelineRun(): void {
    pipelinePaused = false;
    pipelinePausedAtMs = undefined;
    pipelineRunStartedAtMs = Date.now();
    runTerminated = false;
    lastStopReason = undefined;
    lastTerminationMode = undefined;
  }

  async function pausePipeline(): Promise<PipelinePauseResult> {
    const bound = scoped ?? (await requireScoped());
    const slotsBefore = heldWorkerSlots.size;

    // Abort workers first — never block Pause on tracker discovery while
    // Create-tickets publish (or other force-load paths) is wedged on gh.
    const affectedAttempts = await abortSessionWorkers({
      setCooldown: false,
      transcriptEvent: {
        type: "pipeline:pause",
        reason: "pipeline-pause",
      },
      preservePendingIntegrationMessage:
        "Conflict resolution worker aborted by Pipeline pause. In-progress merge is preserved for retry.",
    });

    // Abort releases per-worker slots; drain any remaining bound capacity.
    const releasedRemaining = await releaseAllHeldWorkerSlots(bound);
    const releasedWorkerSlotCount = Math.max(slotsBefore, releasedRemaining);
    // Best-effort Target lease release from session memory only (no force load).
    const targetForRelease =
      cachedPanelActive?.coordination?.target ??
      heldWorkflowCoordinatorLease?.target ??
      heldTargetBranchLease?.target;
    const releasedTargetBranchLease = await releaseBoundTargetBranchLease(
      bound,
      targetForRelease,
    );

    pipelinePaused = true;
    pipelinePausedAtMs = Date.now();
    runTerminated = false;
    lastStopReason = "pipeline-pause";
    lastTerminationMode = undefined;

    return {
      abortedWorkerCount: affectedAttempts.length,
      affectedAttempts,
      pipelinePaused: true,
      releasedTargetBranchLease,
      releasedWorkerSlotCount,
    };
  }

  async function resumePipeline(): Promise<PipelineResumeResult> {
    pipelinePaused = false;
    pipelinePausedAtMs = undefined;
    if (lastStopReason === "pipeline-pause") {
      lastStopReason = undefined;
    }
    // Resume never clears Run termination — that ends the run deliberately.
    return { pipelinePaused: false };
  }

  function resolveTerminationMode(
    active: ActiveWorkflow | undefined,
  ): RunTerminationMode {
    const hasIntegrated =
      (active?.integratedTickets?.length ?? 0) > 0 || Boolean(active?.workflowPr);
    return hasIntegrated ? "stop-only" : "discard-unintegrated";
  }

  /**
   * Collect local unintegrated attempt / integration branches for T2 discard.
   * Never includes branches recorded on integratedTickets.
   */
  async function collectUnintegratedBranches(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<string[]> {
    const integratedBranches = new Set(
      (active.integratedTickets ?? []).map((t) => t.branchName),
    );
    const listed = await bound.workspace.listWorkflowBranches(active.workflowId);
    const candidates = new Set<string>();

    for (const branch of listed) {
      if (integratedBranches.has(branch)) continue;
      // T2 has no successful integrate / PR — discard attempt + integration branches.
      candidates.add(branch);
    }

    // Session-known attempt branches (in case list is incomplete in tests / recovery).
    const sessionBranches = [
      ...[...activeImplementationWorkers.values()].map((w) => w.branchName),
      pendingDisposition?.branchName,
      pendingIntegration?.branchName,
      pendingIntegration?.conflict?.integrationBranch,
      activeConflictWorker?.integrationBranch,
    ].filter((b): b is string => Boolean(b));
    for (const branch of sessionBranches) {
      if (!integratedBranches.has(branch)) {
        candidates.add(branch);
      }
    }

    // Never discard a sibling workflow's namespace even if session state is corrupt.
    return filterWorkflowOwnedBranches(active.workflowId, [...candidates]);
  }

  async function terminateRun(): Promise<RunTerminationResult> {
    const bound = scoped ?? (await requireScoped());
    // Prefer session cache so Terminate cannot hang on tracker force-load while
    // Create-tickets publish is blocked on the same gh path. Soft load only if
    // cache is empty; gh timeout still bounds the wait.
    let active: ActiveWorkflow | undefined = cachedPanelActive;
    if (!active) {
      try {
        active = await loadActiveWorkflow(bound, { force: false });
      } catch {
        active = undefined;
      }
    }
    const mode = resolveTerminationMode(active);
    const slotsBefore = heldWorkerSlots.size;

    const affectedAttempts = await abortSessionWorkers({
      setCooldown: false,
      transcriptEvent: {
        type: "pipeline:terminate",
        reason: "run-termination",
        mode,
      },
      preservePendingIntegrationMessage:
        mode === "stop-only"
          ? "Conflict resolution worker aborted by Run termination (stop-only). In-progress merge is preserved."
          : "Conflict resolution worker aborted by Run termination; unintegrated artifacts may be discarded.",
    });

    // Also log terminate against pending disposition / integration attempts that
    // had no live worker (so attempt history still records the stop).
    const loggedKeys = new Set(
      affectedAttempts.map(
        (a) => `${a.workflowId}:${a.ticketNumber}:${a.attempt}`,
      ),
    );
    const extraAttempts: Array<{
      workflowId: number;
      ticketNumber: number;
      attempt: number;
    }> = [];
    if (pendingDisposition) {
      extraAttempts.push({
        workflowId: pendingDisposition.workflowId,
        ticketNumber: pendingDisposition.ticketNumber,
        attempt: pendingDisposition.attempt,
      });
    }
    for (const worker of activeImplementationWorkers.values()) {
      if (worker.status !== "needs-disposition") continue;
      extraAttempts.push({
        workflowId: worker.workflowId,
        ticketNumber: worker.ticketNumber,
        attempt: worker.attempt,
      });
    }
    if (pendingIntegration) {
      extraAttempts.push({
        workflowId: pendingIntegration.workflowId,
        ticketNumber: pendingIntegration.ticketNumber,
        attempt: pendingIntegration.attempt,
      });
    }
    for (const key of extraAttempts) {
      const id = `${key.workflowId}:${key.ticketNumber}:${key.attempt}`;
      if (loggedKeys.has(id)) continue;
      loggedKeys.add(id);
      await bound.transcripts.append(key, {
        type: "pipeline:terminate",
        reason: "run-termination",
        mode,
      });
    }

    let discardedBranches: readonly string[] = [];
    let discardedWorktrees: readonly string[] = [];

    if (mode === "discard-unintegrated" && active) {
      const toRemove = await collectUnintegratedBranches(bound, active);
      if (toRemove.length > 0) {
        // Record terminate on discarded attempts even when no live worker remained.
        for (const branch of toRemove) {
          const match =
            /^matt-auto\/(\d+)\/ticket-(\d+)\/r(\d+)$/.exec(branch);
          if (!match) continue;
          const key = {
            workflowId: Number(match[1]),
            ticketNumber: Number(match[2]),
            attempt: Number(match[3]),
          };
          const id = `${key.workflowId}:${key.ticketNumber}:${key.attempt}`;
          if (loggedKeys.has(id)) continue;
          loggedKeys.add(id);
          await bound.transcripts.append(key, {
            type: "pipeline:terminate",
            reason: "run-termination",
            mode,
            discarded: true,
          });
        }
        try {
          const removed = await bound.workspace.removeLocalBranches(toRemove);
          discardedBranches = removed.removedLocalBranches;
          discardedWorktrees = removed.removedWorktrees;
        } catch {
          // Best-effort local discard; run still ends.
          discardedBranches = [];
          discardedWorktrees = [];
        }
      }
      // Session-local unfinished work is discarded with T2 artifacts.
      pendingDisposition = undefined;
      pendingIntegration = undefined;
      pendingCiRecovery = undefined;
      integrationInProgress = false;
      // Discard completed-but-not-yet-disposed multi-worker entries too.
      activeImplementationWorkers.clear();
    } else {
      // T1 stop-only: clear live run pointers but never rewrite integrated history.
      // Keep pendingIntegration conflict state recoverable for a later retry.
      pendingDisposition = undefined;
      pendingCiRecovery = undefined;
      // Drop session disposition queue; transcripts remain for recovery.
      for (const [id, worker] of [...activeImplementationWorkers]) {
        if (worker.status === "needs-disposition") {
          activeImplementationWorkers.delete(id);
        }
      }
    }

    const releasedRemaining = await releaseAllHeldWorkerSlots(bound);
    const releasedWorkerSlotCount = Math.max(slotsBefore, releasedRemaining);
    const releasedTargetBranchLease = await releaseBoundTargetBranchLease(
      bound,
      active?.coordination?.target,
    );

    pipelinePaused = false;
    pipelinePausedAtMs = undefined;
    runTerminated = true;
    lastStopReason = "run-termination";
    lastTerminationMode = mode;

    return {
      mode,
      abortedWorkerCount: affectedAttempts.length,
      affectedAttempts,
      discardedBranches,
      discardedWorktrees,
      runTerminated: true,
      releasedTargetBranchLease,
      releasedWorkerSlotCount,
    };
  }

  async function emergencyStop(): Promise<EmergencyStopResult> {
    const bound = scoped ?? (await requireScoped());
    const slotsBefore = heldWorkerSlots.size;
    const hadCoordinatorLease = Boolean(heldWorkflowCoordinatorLease);

    // Abort and release from session memory first — do not await force tracker load.
    const affectedAttempts = await abortSessionWorkers({
      setCooldown: true,
      transcriptEvent: {
        type: "pipeline:emergency-stop",
        reason: "emergency-stop",
      },
      preservePendingIntegrationMessage:
        "Conflict resolution worker aborted by emergency stop. In-progress merge is preserved.",
    });

    const releasedRemaining = await releaseAllHeldWorkerSlots(bound);
    const releasedWorkerSlotCount = Math.max(slotsBefore, releasedRemaining);
    const targetForRelease =
      cachedPanelActive?.coordination?.target ??
      heldWorkflowCoordinatorLease?.target ??
      heldTargetBranchLease?.target;
    const releasedTargetBranchLease = await releaseBoundTargetBranchLease(
      bound,
      targetForRelease,
    );
    await releaseHeldWorkflowCoordinatorLease(bound);
    coordinatorLeaseLost = false;

    pipelinePaused = false;
    pipelinePausedAtMs = undefined;
    runTerminated = true;
    lastStopReason = "emergency-stop";
    lastTerminationMode = undefined;

    return {
      abortedWorkerCount: affectedAttempts.length,
      affectedAttempts,
      releasedTargetBranchLease,
      releasedWorkerSlotCount,
      releasedCoordinatorLease: hadCoordinatorLease,
      runTerminated: true,
      lastStopReason: "emergency-stop",
    };
  }

  /**
   * True when panel reconcile may treat a missing/dead runtime as process death.
   * Requires a prior alive observation so the launch window (worker registered
   * before WorkersPort publishes the child) is not misclassified as gone.
   */
  function shouldSynthesizeProcessExit(
    worker: {
      workerId: string;
      processObservedAlive?: boolean;
      receivedStageResult?: boolean;
    },
    runtime: { alive: boolean; pid?: number } | undefined,
  ): boolean {
    if (worker.receivedStageResult) return false;
    if (processExitHandling.has(worker.workerId)) return false;
    if (processGoneSynthesized.has(worker.workerId)) return false;
    if (runtime?.alive) return false;
    // Missing runtime or explicit !alive only counts after we saw the process
    // alive — never during the launch window before WorkersPort registers it.
    return worker.processObservedAlive === true;
  }

  function noteRuntimeObservation(
    worker: { processObservedAlive?: boolean },
    runtime: { alive: boolean } | undefined,
  ): void {
    if (runtime?.alive) {
      worker.processObservedAlive = true;
    }
  }

  /**
   * If panel still says running but the OS child is gone, synthesize process-exit
   * so the pipeline does not wait forever on a zombie in-memory worker.
   * Never synthesizes during the launch window (runtime not observed alive yet)
   * and never re-enters settlement while process-exit is already in flight.
   */
  async function reconcileDeadWorkers(bound: RootScopedPorts): Promise<void> {
    const running = [...activeImplementationWorkers.values()].filter(
      (w) => w.status === "running",
    );
    for (const worker of running) {
      const runtime = bound.workers.getRuntime(worker.workerId);
      noteRuntimeObservation(worker, runtime);
      if (!shouldSynthesizeProcessExit(worker, runtime)) {
        continue;
      }
      // Claim before any await so concurrent panel polls skip this worker.
      processGoneSynthesized.add(worker.workerId);
      const transcriptKey = {
        workflowId: worker.workflowId,
        ticketNumber: worker.ticketNumber,
        attempt: worker.attempt,
      };
      await bound.transcripts.append(transcriptKey, {
        type: "process-gone",
        workerId: worker.workerId,
        pid: worker.pid ?? runtime?.pid,
        reason:
          "Panel still marked running but the OS process is gone; synthesizing process-exit.",
      });
      await handleWorkerEvent(bound, {
        type: "process-exit",
        workerId: worker.workerId,
        code: null,
      });
    }

    if (activeConflictWorker && activeConflictWorker.status === "running") {
      const conflict = activeConflictWorker;
      const runtime = bound.workers.getRuntime(conflict.workerId);
      noteRuntimeObservation(conflict, runtime);
      if (!shouldSynthesizeProcessExit(conflict, runtime)) {
        return;
      }
      processGoneSynthesized.add(conflict.workerId);
      const transcriptKey = {
        workflowId: conflict.workflowId,
        ticketNumber: conflict.ticketNumber,
        attempt: conflict.attempt,
      };
      await bound.transcripts.append(transcriptKey, {
        type: "process-gone",
        workerId: conflict.workerId,
        pid: conflict.pid ?? runtime?.pid,
        reason:
          "Conflict worker still marked running but the OS process is gone; synthesizing process-exit.",
      });
      await handleWorkerEvent(bound, {
        type: "process-exit",
        workerId: conflict.workerId,
        code: null,
      });
    }
  }

  function panelWorkerInspection(
    worker: {
      workerId: string;
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      branchName: string;
      worktreePath: string;
      status: ImplementationWorkerStatus;
      workerProfile?: WorkerProfile;
      turnCount?: number;
      lastTurnStartedAtMs?: number;
      progress?: string;
      pid?: number;
      startedAtMs?: number;
    },
    bound: RootScopedPorts,
  ): WorkflowPanelState["workers"][number] {
    const rootPath = selectedPath ?? ports.startPath;
    const transcriptPath = workerTranscriptPath(rootPath, {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    });
    const runtime = bound.workers.getRuntime(worker.workerId);
    const pid =
      typeof worker.pid === "number"
        ? worker.pid
        : typeof runtime?.pid === "number"
          ? runtime.pid
          : undefined;
    const entry: WorkflowPanelState["workers"][number] = {
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
      status: worker.status,
      branchName: worker.branchName,
      workerId: worker.workerId,
      worktreePath: worker.worktreePath,
      transcriptPath,
      ...(worker.workerProfile
        ? { workerProfile: { ...worker.workerProfile } }
        : {}),
    };
    if (typeof pid === "number") {
      entry.pid = pid;
    }
    if (worker.status === "running") {
      entry.processAlive = runtime?.alive ?? false;
    } else if (runtime) {
      entry.processAlive = runtime.alive;
    }
    if (typeof worker.turnCount === "number") {
      entry.turnCount = worker.turnCount;
    }
    if (typeof worker.lastTurnStartedAtMs === "number") {
      entry.lastTurnStartedAtMs = worker.lastTurnStartedAtMs;
    }
    if (worker.progress) {
      entry.progress = worker.progress;
    }
    if (typeof worker.startedAtMs === "number") {
      entry.startedAtMs = worker.startedAtMs;
      const endMs =
        pipelinePaused && typeof pipelinePausedAtMs === "number"
          ? pipelinePausedAtMs
          : Date.now();
      entry.runtimeMs = Math.max(0, endMs - worker.startedAtMs);
    }
    return entry;
  }

  /** Cached for wait-loop local panel snapshots (invalidate on tracker mutations). */
  let cachedPanelActive: ActiveWorkflow | undefined;
  let cachedTicketProgress:
    | { workflowId: number; progress: TicketProgressSummary }
    | undefined;

  function invalidatePanelCaches(): void {
    cachedPanelActive = undefined;
    cachedTicketProgress = undefined;
    cachedParallelDelivery = undefined;
    workflowHomeRouteTtl = undefined;
    ticketProgressTtl = undefined;
  }

  async function observeParallelDelivery(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
    mode: "full" | "local",
  ): Promise<ParallelDeliveryPanelState | undefined> {
    if (!active.coordination) return undefined;

    if (
      mode === "local" &&
      cachedParallelDelivery &&
      cachedParallelDelivery.workflowId === active.workflowId
    ) {
      // Refresh only in-memory lease ownership flags on local polls.
      const cached = cachedParallelDelivery.state;
      return {
        ...cached,
        coordinatorLease:
          heldWorkflowCoordinatorLease &&
          heldWorkflowCoordinatorLease.workflowId === active.workflowId
            ? {
                status: "held",
                generation: heldWorkflowCoordinatorLease.lease.generation,
                holderId: heldWorkflowCoordinatorLease.lease.holderId,
                expiresAt: heldWorkflowCoordinatorLease.lease.expiresAt,
                heldByUs: true,
              }
            : coordinatorLeaseLost
              ? { status: "lost" }
              : cached.coordinatorLease,
        ...(heldTargetBranchLease
          ? {
              targetBranchLease: {
                status: "held-by-us" as const,
                holderId: heldTargetBranchLease.lease.holderId,
                ...(typeof heldTargetBranchLease.lease.workflowId === "number"
                  ? { workflowId: heldTargetBranchLease.lease.workflowId }
                  : {}),
                generation: heldTargetBranchLease.lease.generation,
                expiresAt: heldTargetBranchLease.lease.expiresAt,
                ...(heldTargetBranchLease.phase
                  ? { phase: heldTargetBranchLease.phase }
                  : {}),
              },
            }
          : {}),
      };
    }

    const target = active.coordination.target;
    let siblingsOnTarget: readonly ActiveWorkflow[] = [active];
    let coordinatorLeaseRemote: WorkflowCoordinatorLease | undefined;
    let targetBranchLeaseRemote: TargetBranchLease | undefined;
    let workerSlotLeases: WorkerSlotLease[] = [];
    let workerCapacity: number | undefined;

    try {
      siblingsOnTarget = await bound.tracker.findActiveWorkflows(target);
    } catch {
      siblingsOnTarget = [active];
    }

    if (bound.coordination) {
      try {
        const observedCoordinator = await bound.coordination.getLease({
          kind: "workflow-coordinator",
          repository: target.repository,
          target,
          workflowId: active.workflowId,
        });
        if (
          observedCoordinator &&
          observedCoordinator.kind === "workflow-coordinator"
        ) {
          coordinatorLeaseRemote = observedCoordinator;
        }
      } catch {
        // Observation is best-effort; panel must not invent lease health.
      }

      try {
        const observedTarget = await bound.coordination.getLease({
          kind: "target-branch",
          target,
        });
        if (observedTarget && observedTarget.kind === "target-branch") {
          targetBranchLeaseRemote = observedTarget;
        }
      } catch {
        // Best-effort observation.
      }

      try {
        const leases = await bound.coordination.listLeases({
          repository: target.repository,
          kind: "worker-slot",
        });
        workerSlotLeases = leases.filter(
          (lease): lease is WorkerSlotLease => lease.kind === "worker-slot",
        );
      } catch {
        workerSlotLeases = [];
      }

      try {
        const policy = await bound.coordination.getWorkerCapacityPolicy(
          target.repository,
        );
        if (policy) workerCapacity = policy.workerCapacity;
      } catch {
        workerCapacity = undefined;
      }
    }

    const state = buildParallelDeliveryPanelState({
      boundWorkflowId: active.workflowId,
      active,
      siblingsOnTarget,
      ...(coordinatorLeaseRemote
        ? { coordinatorLease: coordinatorLeaseRemote }
        : heldWorkflowCoordinatorLease
          ? { coordinatorLease: heldWorkflowCoordinatorLease.lease }
          : {}),
      coordinatorLeaseHeldByUs:
        heldWorkflowCoordinatorLease?.workflowId === active.workflowId,
      coordinatorLeaseLost,
      ...(targetBranchLeaseRemote
        ? { targetBranchLease: targetBranchLeaseRemote }
        : heldTargetBranchLease
          ? { targetBranchLease: heldTargetBranchLease.lease }
          : {}),
      targetBranchLeaseHeldByUs: Boolean(heldTargetBranchLease),
      ...(heldTargetBranchLease?.phase
        ? { targetBranchLeasePhase: heldTargetBranchLease.phase }
        : {}),
      workerSlotLeases,
      ...(typeof workerCapacity === "number" ? { workerCapacity } : {}),
      holderId: workflowHomeHolderId,
    });

    if (state) {
      cachedParallelDelivery = {
        workflowId: active.workflowId,
        state,
      };
    } else {
      cachedParallelDelivery = undefined;
    }
    return state;
  }

  async function getPanelState(options?: {
    mode?: "full" | "local";
  }): Promise<WorkflowPanelState | undefined> {
    const bound = await requireScoped();
    const mode = options?.mode ?? "full";
    await heartbeatHeldWorkflowCoordinatorLease(bound);
    // Local wait-loop polls are frequent; only full refreshes verify remote
    // worker-slot ownership (renew still runs on interval either way).
    await heartbeatHeldWorkerSlots(bound, { verify: mode === "full" });
    // Detect zombie running state before snapshotting the panel.
    await reconcileDeadWorkers(bound);

    let active: ActiveWorkflow | undefined;
    if (mode === "local" && cachedPanelActive) {
      active = cachedPanelActive;
    } else {
      active = await loadActiveWorkflow(bound);
      cachedPanelActive = active;
      if (!active) {
        cachedTicketProgress = undefined;
      }
    }
    if (!active) return undefined;

    await recoverCompletedWorkerTelemetryFromTranscripts(bound, active);

    let progress: TicketProgressSummary | undefined;
    if (
      mode === "local" &&
      cachedTicketProgress &&
      cachedTicketProgress.workflowId === active.workflowId
    ) {
      progress = cachedTicketProgress.progress;
    } else {
      progress = await loadTicketProgress(bound, active);
      if (progress) {
        cachedTicketProgress = {
          workflowId: active.workflowId,
          progress,
        };
      } else {
        cachedTicketProgress = undefined;
      }
    }
    const implementationWorkers = listImplementationWorkersForPanel();
    const workers =
      implementationWorkers.length > 0
        ? implementationWorkers.map((worker) =>
            panelWorkerInspection(
              {
                workerId: worker.workerId,
                workflowId: worker.workflowId,
                ticketNumber: worker.ticketNumber,
                attempt: worker.attempt,
                branchName: worker.branchName,
                worktreePath: worker.worktreePath,
                status: worker.status,
                ...(worker.workerProfile
                  ? { workerProfile: worker.workerProfile }
                  : {}),
                ...(typeof worker.turnCount === "number"
                  ? { turnCount: worker.turnCount }
                  : {}),
                ...(typeof worker.lastTurnStartedAtMs === "number"
                  ? { lastTurnStartedAtMs: worker.lastTurnStartedAtMs }
                  : {}),
                startedAtMs: worker.startedAtMs,
                ...(worker.progress ? { progress: worker.progress } : {}),
                ...(typeof worker.pid === "number" ? { pid: worker.pid } : {}),
              },
              bound,
            ),
          )
        : activeConflictWorker
          ? [
              panelWorkerInspection(
                {
                  workerId: activeConflictWorker.workerId,
                  workflowId: activeConflictWorker.workflowId,
                  ticketNumber: activeConflictWorker.ticketNumber,
                  attempt: activeConflictWorker.attempt,
                  branchName: activeConflictWorker.integrationBranch,
                  worktreePath: activeConflictWorker.integrationWorktreePath,
                  status: activeConflictWorker.status,
                  ...(activeConflictWorker.workerProfile
                    ? { workerProfile: activeConflictWorker.workerProfile }
                    : {}),
                  ...(typeof activeConflictWorker.turnCount === "number"
                    ? { turnCount: activeConflictWorker.turnCount }
                    : {}),
                  ...(typeof activeConflictWorker.lastTurnStartedAtMs === "number"
                    ? {
                        lastTurnStartedAtMs:
                          activeConflictWorker.lastTurnStartedAtMs,
                      }
                    : {}),
                  startedAtMs: activeConflictWorker.startedAtMs,
                  ...(activeConflictWorker.progress
                    ? { progress: activeConflictWorker.progress }
                    : {}),
                  ...(typeof activeConflictWorker.pid === "number"
                    ? { pid: activeConflictWorker.pid }
                    : {}),
                },
                bound,
              ),
            ]
          : [];

    const completedWorkerRuns = getCompletedWorkerTelemetry(active.workflowId);
    const lines = panelLines(
      active.workflowId,
      progress,
      implementationWorkers,
    );
    appendWorkflowPrPanelLines(lines, active);
    const state: WorkflowPanelState = {
      workflowId: active.workflowId,
      lines,
      workers,
      pipelinePaused,
    };
    if (createTicketsPublishInProgress) {
      state.createTicketsPublishInProgress = true;
    }
    if (completedWorkerRuns.length > 0) {
      state.completedWorkerRuns = completedWorkerRuns;
    }
    const implementationRecovery = getImplementationRecoveryStates();
    if (implementationRecovery.length > 0) {
      state.implementationRecovery = implementationRecovery;
    }
    if (typeof pipelineRunStartedAtMs === "number") {
      state.runStartedAtMs = pipelineRunStartedAtMs;
      const endMs =
        pipelinePaused && typeof pipelinePausedAtMs === "number"
          ? pipelinePausedAtMs
          : Date.now();
      state.runElapsedMs = Math.max(0, endMs - pipelineRunStartedAtMs);
    }
    if (active.title?.trim()) {
      state.title = active.title.trim();
    }
    if (runTerminated) {
      state.runTerminated = true;
    }
    if (lastStopReason) {
      state.lastStopReason = lastStopReason;
    }
    if (lastTerminationMode) {
      state.terminationMode = lastTerminationMode;
    }
    if (progress) {
      state.ticketProgress = progress;
    }
    if (active.workflowPr) {
      state.workflowPr = {
        number: active.workflowPr.number,
        status: active.stage === "merged" ? "merged" : "open",
        baseBranch: active.workflowPr.baseBranch,
        headBranch: active.workflowPr.headBranch,
        ...(active.workflowPr.url ? { url: active.workflowPr.url } : {}),
      };
    }
    if (activeConflictWorker) {
      state.integration = {
        ticketNumber: activeConflictWorker.ticketNumber,
        attempt: activeConflictWorker.attempt,
        status: "conflict-resolution",
        branchName: activeConflictWorker.integrationBranch,
        ...(activeConflictWorker.resolutionKind === "target-refresh"
          ? {
              reason:
                pendingTargetRefresh?.lastFailure ??
                "Target-branch refresh conflict",
            }
          : pendingIntegration?.lastFailure
            ? { reason: pendingIntegration.lastFailure }
            : {}),
      };
    } else if (pendingTargetRefresh && targetRefreshInProgress) {
      if (integrationUnitStartedAtMs === undefined) {
        integrationUnitStartedAtMs = Date.now();
      }
      state.integration = {
        ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
        attempt: pendingTargetRefresh.attempt,
        status: "running",
        branchName: pendingTargetRefresh.integrationBranch,
        reason: "Target-branch refresh",
        runtimeMs: Math.max(0, Date.now() - integrationUnitStartedAtMs),
      };
    } else if (pendingTargetRefresh) {
      integrationUnitStartedAtMs = undefined;
      state.integration = {
        ticketNumber: TARGET_REFRESH_TRANSCRIPT_TICKET,
        attempt: pendingTargetRefresh.attempt,
        status: "pending-retry",
        branchName: pendingTargetRefresh.integrationBranch,
        ...(pendingTargetRefresh.lastFailure
          ? { reason: pendingTargetRefresh.lastFailure }
          : { reason: "Target-branch refresh" }),
      };
    } else if (pendingIntegration && integrationInProgress) {
      // Unit is actively finishing (merge/verify/push) — wait must not P1-settle.
      // Do not surface lastFailure while running: that is a prior attempt's fact
      // and freezes the brief as if the unit is still failed.
      if (integrationUnitStartedAtMs === undefined) {
        integrationUnitStartedAtMs = Date.now();
      }
      state.integration = {
        ticketNumber: pendingIntegration.ticketNumber,
        attempt: pendingIntegration.attempt,
        status: "running",
        branchName: pendingIntegration.conflict
          ? pendingIntegration.conflict.integrationBranch
          : pendingIntegration.branchName,
        runtimeMs: Math.max(0, Date.now() - integrationUnitStartedAtMs),
      };
    } else if (pendingIntegration) {
      integrationUnitStartedAtMs = undefined;
      state.integration = {
        ticketNumber: pendingIntegration.ticketNumber,
        attempt: pendingIntegration.attempt,
        status: "pending-retry",
        branchName: pendingIntegration.conflict
          ? pendingIntegration.conflict.integrationBranch
          : pendingIntegration.branchName,
        ...(pendingIntegration.lastFailure
          ? { reason: pendingIntegration.lastFailure }
          : {}),
      };
    } else {
      integrationUnitStartedAtMs = undefined;
    }

    const ciEntries: NonNullable<WorkflowPanelState["ci"]>[number][] = [];
    if (pendingCiRecovery) {
      ciEntries.push({
        ticketNumber: pendingCiRecovery.ticketNumber,
        attempt: pendingCiRecovery.attempt,
        status: "failure",
        integrationBranch: pendingCiRecovery.integrationBranch,
        ...(pendingCiRecovery.summary ? { summary: pendingCiRecovery.summary } : {}),
        ...(pendingCiRecovery.url ? { url: pendingCiRecovery.url } : {}),
      });
    } else if (progress) {
      for (const ticket of progress.awaitingCi) {
        const integrated = active.integratedTickets?.find((t) => t.number === ticket.number);
        ciEntries.push({
          ticketNumber: ticket.number,
          attempt: integrated?.attempt ?? 1,
          status: "awaiting-check",
          integrationBranch:
            active.integrationBranch ?? integrationBranchName(active.workflowId),
        });
      }
    }
    if (ciEntries.length > 0) {
      state.ci = ciEntries;
    }

    const parallelDelivery = await observeParallelDelivery(bound, active, mode);
    if (parallelDelivery) {
      state.parallelDelivery = parallelDelivery;
    }

    return state;
  }

  async function getWorkerTranscript(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }): Promise<readonly unknown[]> {
    const bound = await requireScoped();
    return bound.transcripts.read(input);
  }

  async function currentRoot(): Promise<WorkflowRoot> {
    return ensureSelected();
  }

  async function listLocalUnfinishedWorkflows(): Promise<
    readonly LocalUnfinishedWorkflow[]
  > {
    const root = await ensureSelected();
    return scanLocalUnfinishedWorkflows(root.path);
  }

  async function selectLocalUnfinishedWorkflow(
    workflowId: number,
  ): Promise<void> {
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      throw new Error(`Invalid local Workflow ID: ${workflowId}`);
    }
    const bound = await requireScoped();
    const targetBranch = await resolveTargetBranch(
      bound.preferences,
      bound.environment,
    );
    await bound.preferences.setActiveWorkflowId(targetBranch, workflowId);
    // Drop route cache so the next GitHub load uses the new local pointer.
    workflowHomeRouteTtl = undefined;
    cachedPanelActive = undefined;
    cachedTicketProgress = undefined;
  }

  let rootsCache: { roots: WorkflowRoot[]; at: number; startPath: string } | undefined;
  const ROOTS_TTL_MS = 30_000;

  async function listRoots(): Promise<WorkflowRoot[]> {
    await ensureSelected();
    if (
      rootsCache &&
      rootsCache.startPath === ports.startPath &&
      Date.now() - rootsCache.at < ROOTS_TTL_MS
    ) {
      return rootsCache.roots;
    }
    const roots = await discoverRoots();
    rootsCache = { roots, at: Date.now(), startPath: ports.startPath };
    return roots;
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

    // Session-owned workers abort cleanly on Workflow-root switching.
    if (scoped && selectedPath && path.resolve(selectedPath) !== resolved) {
      await abortWorkers();
      await releaseWorkflowHome();
      // Follow-up pointer is session-local to the previous Workflow root.
      lastCompletedWorkflow = undefined;
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

  async function setActiveWorkflowWorkerProfile(
    profile: WorkerProfile,
  ): Promise<void> {
    const bound = await requireScoped();
    await assertValidWorkerProfile(profile);
    const active = await loadActiveWorkflow(bound, { force: true });
    if (!active) {
      throw new Error(
        "No Active workflow on this Target branch. Configure the global default or Workflow-root override instead.",
      );
    }
    const manifest = manifestFromActive(active);
    manifest.workerProfile = {
      provider: profile.provider,
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
    };
    await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
    // Drop TTL so the next resolve reads the rewritten snapshot immediately.
    workflowHomeRouteTtl = undefined;
  }

  async function getEffectiveWorkerConcurrency(): Promise<number> {
    const bound = await requireScoped();
    const root = await bound.preferences.getRootWorkerConcurrency();
    const global = await bound.preferences.getGlobalWorkerConcurrency();
    return resolveEffectiveWorkerConcurrency(root, global);
  }

  async function getGlobalWorkerConcurrency(): Promise<number | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getGlobalWorkerConcurrency();
  }

  async function getRootWorkerConcurrency(): Promise<number | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getRootWorkerConcurrency();
  }

  async function setGlobalWorkerConcurrency(
    concurrency: number,
  ): Promise<void> {
    const bound = await requireScoped();
    assertValidWorkerConcurrency(concurrency);
    await bound.preferences.setGlobalWorkerConcurrency(concurrency);
  }

  async function setRootWorkerConcurrency(
    concurrency: number,
  ): Promise<void> {
    const bound = await requireScoped();
    assertValidWorkerConcurrency(concurrency);
    await bound.preferences.setRootWorkerConcurrency(concurrency);
  }

  async function clearRootWorkerConcurrency(): Promise<void> {
    const bound = await requireScoped();
    await bound.preferences.clearRootWorkerConcurrency();
  }

  async function getEffectiveLiveWaitPollIntervalMs(): Promise<number> {
    const bound = await requireScoped();
    const root = await bound.preferences.getRootLiveWaitPollIntervalMs();
    const global = await bound.preferences.getGlobalLiveWaitPollIntervalMs();
    return resolveLiveWaitPollInterval(root, global).intervalMs;
  }

  async function getGlobalLiveWaitPollIntervalMs(): Promise<number | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getGlobalLiveWaitPollIntervalMs();
  }

  async function getRootLiveWaitPollIntervalMs(): Promise<number | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getRootLiveWaitPollIntervalMs();
  }

  async function setGlobalLiveWaitPollIntervalMs(
    intervalMs: number,
  ): Promise<void> {
    const bound = await requireScoped();
    assertValidLiveWaitPollIntervalMs(intervalMs);
    await bound.preferences.setGlobalLiveWaitPollIntervalMs(intervalMs);
  }

  async function setRootLiveWaitPollIntervalMs(
    intervalMs: number,
  ): Promise<void> {
    const bound = await requireScoped();
    assertValidLiveWaitPollIntervalMs(intervalMs);
    await bound.preferences.setRootLiveWaitPollIntervalMs(intervalMs);
  }

  async function clearRootLiveWaitPollIntervalMs(): Promise<void> {
    const bound = await requireScoped();
    await bound.preferences.clearRootLiveWaitPollIntervalMs();
  }

  async function listAvailableModels(): Promise<readonly AvailableModel[]> {
    return ports.models.listAvailableModels();
  }

  async function getHomeModel() {
    return ports.models.getHomeModel();
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
    listResumableActiveWorkflows,
    getTicketProgress,
    currentRoot,
    listLocalUnfinishedWorkflows,
    selectLocalUnfinishedWorkflow,
    listRoots,
    selectRoot,
    getWorkerProfile,
    getGlobalWorkerProfile,
    getRootWorkerProfile,
    setGlobalWorkerProfile,
    setRootWorkerProfile,
    setActiveWorkflowWorkerProfile,
    clearRootWorkerProfile,
    getEffectiveWorkerConcurrency,
    getGlobalWorkerConcurrency,
    getRootWorkerConcurrency,
    setGlobalWorkerConcurrency,
    setRootWorkerConcurrency,
    clearRootWorkerConcurrency,
    getEffectiveLiveWaitPollIntervalMs,
    getGlobalLiveWaitPollIntervalMs,
    getRootLiveWaitPollIntervalMs,
    setGlobalLiveWaitPollIntervalMs,
    setRootLiveWaitPollIntervalMs,
    clearRootLiveWaitPollIntervalMs,
    listAvailableModels,
    getHomeModel,
    thinkingLevelsFor,
    getPanelState,
    getCompletedWorkerTelemetry,
    getImplementationRecoveryStates,
    getNextActionsDiagnostic,
    getPipelineRunElapsedMs,
    confirmDisposition,
    abortWorkers,
    releaseWorkflowHome,
    pausePipeline,
    resumePipeline,
    terminateRun,
    emergencyStop,
    isPipelinePaused,
    isRunTerminated,
    reconcileBlockedRunningWorkers,
    beginPipelineRun,
    isAutoAdvanceBlocked,
    getWorkerTranscript,
  };
}
