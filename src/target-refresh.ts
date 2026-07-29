import type {
  PrepareResolveConflictsInput,
  TargetRefreshResult,
  WorkspacePort,
} from "./ports.js";
import type {
  TargetBranchQueueFailureKind,
  TargetBranchQueueOrchestrator,
} from "./target-branch-queue.js";
import type {
  WorkflowCoordinatorLease,
  WorkflowMergeMethod,
  WorkflowPrFreshness,
} from "./types.js";

/**
 * Synthetic transcript ticket number for Target-refresh Conflict resolution.
 * Ticket-to-Integration conflicts keep real ticket numbers; this path is not a ticket.
 */
export const TARGET_REFRESH_TRANSCRIPT_TICKET = 0;

/** Stable machine-readable reasons recorded on queue retry outcomes. */
export const TARGET_REFRESH_FAILURE_REASONS = {
  mergeError: "target-refresh-merge-error",
  conflictResolutionFailed: "target-refresh-conflict-resolution-failed",
  missingStageResult: "target-refresh-missing-stage-result",
  localVerificationFailed: "target-refresh-local-verification-failed",
  pushFailed: "target-refresh-push-failed",
  prUpdateFailed: "target-refresh-pr-update-failed",
  authorityLost: "target-refresh-authority-lost",
} as const;

export type TargetRefreshFailureReason =
  (typeof TARGET_REFRESH_FAILURE_REASONS)[keyof typeof TARGET_REFRESH_FAILURE_REASONS];

/** Preserved Integration merge conflict from a Target-branch refresh. */
export type TargetRefreshConflict = {
  integrationBranch: string;
  integrationWorktreePath: string;
  targetBranch: string;
  targetSha: string;
  message: string;
  targetLeaseGeneration?: number;
};

/** Successful local merge of the Target tip into the Integration branch. */
export type TargetRefreshMerged = {
  status: "merged";
  targetSha: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  mergeCommitSha?: string;
  alreadyUpToDate?: boolean;
};

export type TargetRefreshMergePhaseResult =
  | TargetRefreshMerged
  | {
      status: "conflict";
      conflict: TargetRefreshConflict;
    }
  | {
      status: "failed";
      reason: string;
      failureKind: TargetBranchQueueFailureKind;
      failureReasonCode: TargetRefreshFailureReason;
      targetSha?: string;
    };

/** Build the skill input for a Target-refresh Conflict resolution worker. */
export function targetRefreshConflictSkillInput(
  conflict: TargetRefreshConflict,
  workflowId?: number,
): PrepareResolveConflictsInput {
  return {
    kind: "target-refresh",
    integrationBranch: conflict.integrationBranch,
    targetBranch: conflict.targetBranch,
    targetSha: conflict.targetSha,
    ...(conflict.targetLeaseGeneration !== undefined
      ? { targetLeaseGeneration: conflict.targetLeaseGeneration }
      : {}),
    ...(workflowId !== undefined ? { workflowId } : {}),
  };
}

/** Build the skill input for a ticket-to-Integration Conflict resolution worker. */
export function ticketIntegrationConflictSkillInput(input: {
  ticketNumber: number;
  ticketBranch: string;
  integrationBranch: string;
}): PrepareResolveConflictsInput {
  return {
    kind: "ticket-integration",
    ticketNumber: input.ticketNumber,
    ticketBranch: input.ticketBranch,
    integrationBranch: input.integrationBranch,
  };
}

/**
 * Classify a Target-refresh workspace outcome into the delivery phase shape
 * used by the coordinator (merged / conflict / fail-closed).
 */
export function classifyTargetRefreshResult(input: {
  result: TargetRefreshResult;
  integrationBranch: string;
  integrationWorktreePath: string;
  targetBranch: string;
  targetLeaseGeneration?: number;
}): TargetRefreshMergePhaseResult {
  const { result } = input;
  if (result.ok) {
    return {
      status: "merged",
      targetSha: result.targetSha,
      integrationBranch: input.integrationBranch,
      integrationWorktreePath: input.integrationWorktreePath,
      ...(result.mergeCommitSha ? { mergeCommitSha: result.mergeCommitSha } : {}),
      ...(result.alreadyUpToDate ? { alreadyUpToDate: true } : {}),
    };
  }
  if (result.reason === "conflict" && result.targetSha) {
    return {
      status: "conflict",
      conflict: {
        integrationBranch: input.integrationBranch,
        integrationWorktreePath: input.integrationWorktreePath,
        targetBranch: input.targetBranch,
        targetSha: result.targetSha,
        message: result.message,
        ...(input.targetLeaseGeneration !== undefined
          ? { targetLeaseGeneration: input.targetLeaseGeneration }
          : {}),
      },
    };
  }
  return {
    status: "failed",
    reason: result.message,
    failureKind: "transient",
    failureReasonCode: TARGET_REFRESH_FAILURE_REASONS.mergeError,
    ...(result.targetSha ? { targetSha: result.targetSha } : {}),
  };
}

/** Perform the local Target → Integration merge via WorkspacePort. */
export async function mergeTargetIntoIntegration(input: {
  workspace: WorkspacePort;
  workflowId: number;
  targetBranch: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  targetLeaseGeneration?: number;
  remote?: string;
}): Promise<TargetRefreshMergePhaseResult> {
  const result = await input.workspace.refreshIntegrationFromTarget({
    workflowId: input.workflowId,
    targetBranch: input.targetBranch,
    ...(input.remote ? { remote: input.remote } : {}),
  });
  return classifyTargetRefreshResult({
    result,
    integrationBranch: input.integrationBranch,
    integrationWorktreePath: input.integrationWorktreePath,
    targetBranch: input.targetBranch,
    ...(input.targetLeaseGeneration !== undefined
      ? { targetLeaseGeneration: input.targetLeaseGeneration }
      : {}),
  });
}

/** PR freshness facts written after a successful refresh + local verification + push. */
export function refreshedWorkflowPrFreshness(input: {
  headSha: string;
  validatedTargetSha: string;
  mergeMethod: WorkflowMergeMethod;
}): WorkflowPrFreshness {
  return {
    headSha: input.headSha,
    validatedTargetSha: input.validatedTargetSha,
    mergeMethod: input.mergeMethod,
  };
}

/**
 * Fail closed for a Target-refresh delivery attempt: record a retryable queue
 * outcome and release the Target-branch lease held by the orchestrator.
 */
export async function recordTargetRefreshFailure(input: {
  queue: TargetBranchQueueOrchestrator;
  workflowCoordinatorLease: WorkflowCoordinatorLease;
  failureKind: TargetBranchQueueFailureKind;
  reason: string;
}): Promise<
  | { ok: true }
  | { ok: false; reason: string }
> {
  const recorded = await input.queue.transition({
    kind: "record-failure",
    workflowCoordinatorLease: input.workflowCoordinatorLease,
    failureKind: input.failureKind,
    reason: input.reason,
  });
  if (!recorded.ok) {
    // Best-effort lease release so a failed record cannot pin the serial lane.
    await input.queue.transition({ kind: "release-held-target-lease" });
    return {
      ok: false,
      reason: recorded.reason,
    };
  }
  return { ok: true };
}

/**
 * After a clean refresh or successful conflict resolution: release the serial
 * Target-branch lease while remote PR checks re-run on the refreshed head.
 */
export async function releaseTargetRefreshForPrChecks(input: {
  queue: TargetBranchQueueOrchestrator;
  workflowCoordinatorLease: WorkflowCoordinatorLease;
  prFreshness: WorkflowPrFreshness;
  /** When true, re-admit merge-ready (no required PR checks to wait for). */
  admitMergeReady?: boolean;
}): Promise<
  | { ok: true }
  | { ok: false; reason: string }
> {
  const released = await input.queue.transition({
    kind: "release-for-pr-checks",
    workflowCoordinatorLease: input.workflowCoordinatorLease,
    prFreshness: input.prFreshness,
    ...(input.admitMergeReady ? { admitMergeReady: true } : {}),
  });
  if (!released.ok) {
    await input.queue.transition({ kind: "release-held-target-lease" });
    return { ok: false, reason: released.reason };
  }
  return { ok: true };
}
