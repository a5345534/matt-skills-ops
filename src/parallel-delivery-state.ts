import {
  reconstructTargetBranchQueue,
  targetBranchQueuePosition,
} from "./target-branch-queue.js";
import { isLiveWorkerSlotLease } from "./worker-capacity.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  CoordinatorLeaseHealthObservation,
  ParallelDeliveryPanelState,
  ParallelDeliveryWaitingState,
  SiblingWorkflowSummary,
  TargetBranchLease,
  TargetBranchLeaseObservation,
  TargetBranchQueueCandidate,
  WorkerSlotAllocationSummary,
  WorkerSlotLease,
  WorkflowCoordinatorLease,
} from "./types.js";

/** Observed facts required to build one parallel-delivery panel snapshot. */
export type ParallelDeliveryObservationInput = {
  boundWorkflowId: number;
  /** Bound workflow's Active record (must be coordination-aware for a snapshot). */
  active: ActiveWorkflow;
  /** Every Active workflow for the same canonical Target identity. */
  siblingsOnTarget: readonly ActiveWorkflow[];
  /** Live Workflow coordinator lease for the bound workflow, when observed. */
  coordinatorLease?: WorkflowCoordinatorLease;
  /**
   * True when this home currently holds the bound workflow's coordinator lease
   * (in-memory), regardless of remote observation lag.
   */
  coordinatorLeaseHeldByUs?: boolean;
  /** True when remote verification or heartbeat lost the coordinator lease. */
  coordinatorLeaseLost?: boolean;
  /** Observed Target-branch lease for the canonical Target, if any. */
  targetBranchLease?: TargetBranchLease;
  /** True when this home currently holds the Target-branch lease in memory. */
  targetBranchLeaseHeldByUs?: boolean;
  /** Delivery phase only when this home is actively driving Target work. */
  targetBranchLeasePhase?: TargetBranchLeaseObservation["phase"];
  /** Repository-wide worker-slot leases (including expired/tombstoned). */
  workerSlotLeases?: readonly WorkerSlotLease[];
  /** Authoritative repository worker capacity when observed. */
  workerCapacity?: number;
  /** Holder identity of this Workflow home process. */
  holderId: string;
  /** Injectable clock for lease-liveness checks. */
  nowMs?: number;
};

/**
 * Build the parallel-delivery panel DTO from currently observed facts.
 * Returns undefined for legacy (v1) workflows or when no canonical Target exists.
 */
export function buildParallelDeliveryPanelState(
  input: ParallelDeliveryObservationInput,
): ParallelDeliveryPanelState | undefined {
  const coordination = input.active.coordination;
  if (!coordination) return undefined;
  const target = coordination.target;
  const nowMs = input.nowMs ?? Date.now();

  const coordinatorLease = observeCoordinatorLease({
    ...(input.coordinatorLease ? { lease: input.coordinatorLease } : {}),
    heldByUs: input.coordinatorLeaseHeldByUs === true,
    lost: input.coordinatorLeaseLost === true,
    holderId: input.holderId,
  });

  const targetBranchLease = observeTargetBranchLease({
    ...(input.targetBranchLease ? { lease: input.targetBranchLease } : {}),
    heldByUs: input.targetBranchLeaseHeldByUs === true,
    holderId: input.holderId,
    ...(input.targetBranchLeasePhase
      ? { phase: input.targetBranchLeasePhase }
      : {}),
    nowMs,
  });

  const queueCandidate = coordination.queueCandidate
    ? copyQueueCandidate(coordination.queueCandidate)
    : undefined;

  const queue = reconstructTargetBranchQueue(target, input.siblingsOnTarget);
  const queuePosition = targetBranchQueuePosition(queue, input.boundWorkflowId);
  const queueLength = queue.entries.length;

  const waitingState = deriveParallelDeliveryWaitingState({
    ...(queueCandidate ? { queueCandidate } : {}),
    coordinatorLease,
    ...(targetBranchLease ? { targetBranchLease } : {}),
    ...(targetBranchLease?.phase
      ? { targetBranchLeasePhase: targetBranchLease.phase }
      : {}),
  });

  const workerSlots = buildWorkerSlotAllocationSummary({
    boundWorkflowId: input.boundWorkflowId,
    leases: input.workerSlotLeases ?? [],
    ...(typeof input.workerCapacity === "number"
      ? { capacity: input.workerCapacity }
      : {}),
    nowMs,
  });

  const siblings = buildSiblingWorkflowSummaries({
    boundWorkflowId: input.boundWorkflowId,
    workflows: input.siblingsOnTarget,
    workerSlotLeases: input.workerSlotLeases ?? [],
    nowMs,
  });

  const prFreshness = coordination.prFreshness;
  const state: ParallelDeliveryPanelState = {
    target: copyTarget(target),
    boundWorkflowId: input.boundWorkflowId,
    coordinatorLease,
    waitingState,
    siblings,
  };
  if (targetBranchLease) state.targetBranchLease = targetBranchLease;
  if (queueCandidate) state.queueCandidate = queueCandidate;
  if (queuePosition !== undefined) state.queuePosition = queuePosition;
  if (queueLength > 0) state.queueLength = queueLength;
  if (prFreshness?.headSha) state.prHeadSha = prFreshness.headSha;
  if (prFreshness?.validatedTargetSha) {
    state.validatedTargetSha = prFreshness.validatedTargetSha;
  }
  if (workerSlots) state.workerSlots = workerSlots;
  return state;
}

/** Distill a waiting-state label from currently observed delivery facts. */
export function deriveParallelDeliveryWaitingState(input: {
  queueCandidate?: TargetBranchQueueCandidate;
  coordinatorLease: CoordinatorLeaseHealthObservation;
  targetBranchLease?: TargetBranchLeaseObservation;
  targetBranchLeasePhase?: TargetBranchLeaseObservation["phase"];
}): ParallelDeliveryWaitingState {
  if (
    input.coordinatorLease.status === "lost" ||
    input.targetBranchLease?.status === "lost"
  ) {
    return "lost-lease";
  }

  const candidate = input.queueCandidate;
  if (!candidate) return "not-in-delivery";

  switch (candidate.state) {
    case "merged":
      return "merged";
    case "retryable":
    case "transient-retry":
      return "retryable-failure";
    case "refreshing":
      return "target-refresh";
    case "awaiting-pr-checks":
      return "ci-pending";
    case "merge-ready": {
      const phase =
        input.targetBranchLeasePhase ?? input.targetBranchLease?.phase;
      if (phase === "refresh") return "target-refresh";
      // Merge-ready but another home holds the serial lane ⇒ queue waiting.
      if (input.targetBranchLease?.status === "held-by-other") {
        return "queue-waiting";
      }
      return "merge-ready";
    }
    default:
      return "not-in-delivery";
  }
}

/** Format a short operator-facing waiting-state label. */
export function formatParallelDeliveryWaitingState(
  state: ParallelDeliveryWaitingState,
): string {
  switch (state) {
    case "queue-waiting":
      return "Waiting in Target-branch queue";
    case "ci-pending":
      return "Awaiting PR checks";
    case "target-refresh":
      return "Refreshing from Target branch";
    case "retryable-failure":
      return "Retryable delivery failure";
    case "lost-lease":
      return "Lost coordination lease";
    case "merge-ready":
      return "Merge-ready";
    case "merged":
      return "Merged";
    case "not-in-delivery":
      return "Not in Target-branch delivery";
  }
}

/** Format the canonical Target identity for panel / brief lines. */
export function formatCanonicalTargetIdentity(
  target: CanonicalTargetIdentity,
): string {
  return `${target.repository.owner}/${target.repository.name} ${target.targetRef}`;
}

/** Multi-line parallel-delivery section for the full-screen run brief. */
export function formatParallelDeliveryBriefLines(
  state: ParallelDeliveryPanelState,
): readonly string[] {
  const lines: string[] = [];
  lines.push(`Target: ${formatCanonicalTargetIdentity(state.target)}`);
  lines.push(`Bound workflow: #${state.boundWorkflowId}`);
  lines.push(`Waiting: ${formatParallelDeliveryWaitingState(state.waitingState)}`);
  lines.push(`Coordinator lease: ${formatCoordinatorLease(state.coordinatorLease)}`);

  if (state.targetBranchLease) {
    lines.push(
      `Target-branch lease: ${formatTargetBranchLease(state.targetBranchLease)}`,
    );
  }

  if (state.queueCandidate) {
    lines.push(`Queue state: ${formatQueueCandidate(state.queueCandidate)}`);
  }
  if (typeof state.queuePosition === "number") {
    const of =
      typeof state.queueLength === "number" ? ` of ${state.queueLength}` : "";
    lines.push(`Queue position: ${state.queuePosition}${of}`);
  } else if (typeof state.queueLength === "number" && state.queueLength > 0) {
    lines.push(`Queue length: ${state.queueLength} merge-ready`);
  }

  if (state.prHeadSha) lines.push(`PR head SHA: ${state.prHeadSha}`);
  if (state.validatedTargetSha) {
    lines.push(`Validated target SHA: ${state.validatedTargetSha}`);
  }

  if (state.workerSlots) {
    lines.push(...formatWorkerSlotLines(state.workerSlots));
  }

  if (state.siblings.length > 0) {
    lines.push(`Siblings (${state.siblings.length}):`);
    for (const sibling of state.siblings) {
      lines.push(`  ${formatSiblingSummaryLine(sibling)}`);
    }
  } else {
    lines.push("Siblings: none");
  }

  return lines;
}

/** Compact one-or-few lines for the secondary Workflow panel. */
export function formatParallelDeliveryCompactLines(
  state: ParallelDeliveryPanelState,
): readonly string[] {
  const lines: string[] = [];
  lines.push(
    `Target ${formatCanonicalTargetIdentity(state.target)} · ${formatParallelDeliveryWaitingState(state.waitingState)}`,
  );

  const leaseBits = [
    `coord ${shortLeaseStatus(state.coordinatorLease)}`,
    state.targetBranchLease
      ? `target ${shortTargetLeaseStatus(state.targetBranchLease)}`
      : undefined,
  ].filter(Boolean);
  if (typeof state.queuePosition === "number") {
    const of =
      typeof state.queueLength === "number" ? `/${state.queueLength}` : "";
    leaseBits.push(`q#${state.queuePosition}${of}`);
  }
  if (state.workerSlots) {
    leaseBits.push(
      `slots ${state.workerSlots.boundWorkflowHeldCount}/${state.workerSlots.capacity} (free ${state.workerSlots.freeSlotCount})`,
    );
  }
  if (leaseBits.length > 0) {
    lines.push(leaseBits.join(" · "));
  }

  if (state.siblings.length > 0) {
    const preview = state.siblings
      .slice(0, 3)
      .map((sibling) => `#${sibling.workflowId}`)
      .join(", ");
    const more =
      state.siblings.length > 3 ? ` +${state.siblings.length - 3}` : "";
    lines.push(`Siblings: ${preview}${more}`);
  }

  return lines;
}

function observeCoordinatorLease(input: {
  lease?: WorkflowCoordinatorLease;
  heldByUs: boolean;
  lost: boolean;
  holderId: string;
}): CoordinatorLeaseHealthObservation {
  if (input.lost) return { status: "lost" };
  if (!input.lease) {
    return input.heldByUs
      ? {
          // In-memory hold without a remote snapshot yet — treat as held by us
          // with unknown generation rather than inventing remote facts.
          status: "held",
          generation: 0,
          holderId: input.holderId,
          expiresAt: "",
          heldByUs: true,
        }
      : { status: "absent" };
  }
  if (input.lease.releasedAt) {
    return input.heldByUs ? { status: "lost" } : { status: "absent" };
  }
  return {
    status: "held",
    generation: input.lease.generation,
    holderId: input.lease.holderId,
    expiresAt: input.lease.expiresAt,
    heldByUs:
      input.heldByUs || input.lease.holderId === input.holderId,
  };
}

function observeTargetBranchLease(input: {
  lease?: TargetBranchLease;
  heldByUs: boolean;
  holderId: string;
  phase?: TargetBranchLeaseObservation["phase"];
  nowMs: number;
}): TargetBranchLeaseObservation | undefined {
  if (!input.lease && !input.heldByUs) return undefined;
  if (!input.lease) {
    return {
      status: "held-by-us",
      holderId: input.holderId,
      ...(input.phase ? { phase: input.phase } : {}),
    };
  }
  if (input.lease.releasedAt) {
    return { status: "absent" };
  }
  const expiresAtMs = Date.parse(input.lease.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= input.nowMs) {
    return {
      status: "expired",
      holderId: input.lease.holderId,
      ...(typeof input.lease.workflowId === "number"
        ? { workflowId: input.lease.workflowId }
        : {}),
      generation: input.lease.generation,
      expiresAt: input.lease.expiresAt,
    };
  }
  const heldByUs =
    input.heldByUs || input.lease.holderId === input.holderId;
  return {
    status: heldByUs ? "held-by-us" : "held-by-other",
    holderId: input.lease.holderId,
    ...(typeof input.lease.workflowId === "number"
      ? { workflowId: input.lease.workflowId }
      : {}),
    generation: input.lease.generation,
    expiresAt: input.lease.expiresAt,
    ...(heldByUs && input.phase ? { phase: input.phase } : {}),
  };
}

function buildSiblingWorkflowSummaries(input: {
  boundWorkflowId: number;
  workflows: readonly ActiveWorkflow[];
  workerSlotLeases: readonly WorkerSlotLease[];
  nowMs: number;
}): SiblingWorkflowSummary[] {
  const slotCounts = new Map<number, number>();
  for (const lease of input.workerSlotLeases) {
    if (!isLiveWorkerSlotLease(lease, input.nowMs)) continue;
    slotCounts.set(
      lease.workflowId,
      (slotCounts.get(lease.workflowId) ?? 0) + 1,
    );
  }

  return input.workflows
    .filter((workflow) => workflow.workflowId !== input.boundWorkflowId)
    .filter((workflow) => workflow.coordination !== undefined)
    .slice()
    .sort((left, right) => left.workflowId - right.workflowId)
    .map((workflow) => {
      const coordination = workflow.coordination!;
      const candidate = coordination.queueCandidate;
      const summary: SiblingWorkflowSummary = {
        workflowId: workflow.workflowId,
        heldWorkerSlots: slotCounts.get(workflow.workflowId) ?? 0,
      };
      if (workflow.title?.trim()) summary.title = workflow.title.trim();
      if (candidate) summary.queueState = candidate.state;
      if (workflow.workflowPr) {
        summary.workflowPr = {
          number: workflow.workflowPr.number,
          status: workflow.stage === "merged" ? "merged" : "open",
        };
      }
      if (coordination.prFreshness?.headSha) {
        summary.prHeadSha = coordination.prFreshness.headSha;
      }
      if (coordination.prFreshness?.validatedTargetSha) {
        summary.validatedTargetSha = coordination.prFreshness.validatedTargetSha;
      }
      if (candidate?.state === "merge-ready") {
        summary.mergeReadyAt = candidate.mergeReadyAt;
      }
      return summary;
    });
}

function buildWorkerSlotAllocationSummary(input: {
  boundWorkflowId: number;
  leases: readonly WorkerSlotLease[];
  capacity?: number;
  nowMs: number;
}): WorkerSlotAllocationSummary | undefined {
  if (typeof input.capacity !== "number" || !Number.isSafeInteger(input.capacity)) {
    // Without policy we can still report live occupancy when leases exist.
    if (input.leases.length === 0) return undefined;
  }
  const capacity =
    typeof input.capacity === "number" && Number.isSafeInteger(input.capacity)
      ? Math.max(0, input.capacity)
      : 0;

  const occupied = input.leases
    .filter((lease) => isLiveWorkerSlotLease(lease, input.nowMs))
    .map((lease) => ({
      slot: lease.scope.slot,
      workflowId: lease.workflowId,
      ...(typeof lease.ticketNumber === "number"
        ? { ticketNumber: lease.ticketNumber }
        : {}),
      ownedByBoundWorkflow: lease.workflowId === input.boundWorkflowId,
    }))
    .sort((left, right) => left.slot - right.slot);

  const freeSlotCount =
    capacity > 0
      ? Math.max(0, capacity - occupied.length)
      : 0;
  const boundWorkflowHeldCount = occupied.filter(
    (entry) => entry.ownedByBoundWorkflow,
  ).length;

  return {
    capacity,
    occupied,
    freeSlotCount,
    boundWorkflowHeldCount,
  };
}

function formatCoordinatorLease(
  lease: CoordinatorLeaseHealthObservation,
): string {
  switch (lease.status) {
    case "held":
      return lease.heldByUs
        ? `held by us (gen ${lease.generation})`
        : `held by ${lease.holderId} (gen ${lease.generation})`;
    case "lost":
      return "lost";
    case "absent":
      return "absent";
    case "unavailable":
      return "unavailable";
  }
}

function formatTargetBranchLease(lease: TargetBranchLeaseObservation): string {
  const bits: string[] = [lease.status];
  if (lease.holderId) bits.push(`holder ${lease.holderId}`);
  if (typeof lease.workflowId === "number") bits.push(`workflow #${lease.workflowId}`);
  if (typeof lease.generation === "number") bits.push(`gen ${lease.generation}`);
  if (lease.phase) bits.push(`phase ${lease.phase}`);
  return bits.join(" · ");
}

function formatQueueCandidate(candidate: TargetBranchQueueCandidate): string {
  switch (candidate.state) {
    case "awaiting-pr-checks":
      return "awaiting-pr-checks";
    case "merge-ready":
      return `merge-ready since ${candidate.mergeReadyAt}`;
    case "refreshing":
      return "refreshing";
    case "retryable":
      return `retryable: ${candidate.retry.reason} (attempt ${candidate.retry.attempt})`;
    case "transient-retry":
      return `transient-retry: ${candidate.retry.reason} (attempt ${candidate.retry.attempt}/${candidate.retry.maxAttempts}; next ${candidate.retry.nextRetryAt})`;
    case "merged":
      return "merged";
  }
}

function formatWorkerSlotLines(
  slots: WorkerSlotAllocationSummary,
): string[] {
  const lines = [
    `Worker slots: ${slots.boundWorkflowHeldCount} held by bound · ${slots.occupied.length} occupied / capacity ${slots.capacity} · free ${slots.freeSlotCount}`,
  ];
  for (const entry of slots.occupied) {
    const ticket =
      typeof entry.ticketNumber === "number" ? ` ticket #${entry.ticketNumber}` : "";
    const owned = entry.ownedByBoundWorkflow ? " (ours)" : "";
    lines.push(
      `  slot ${entry.slot}: workflow #${entry.workflowId}${ticket}${owned}`,
    );
  }
  return lines;
}

function formatSiblingSummaryLine(sibling: SiblingWorkflowSummary): string {
  const bits: string[] = [`#${sibling.workflowId}`];
  if (sibling.title) bits.push(sibling.title);
  if (sibling.queueState) bits.push(sibling.queueState);
  if (sibling.workflowPr) {
    bits.push(`PR #${sibling.workflowPr.number} ${sibling.workflowPr.status}`);
  }
  if (sibling.heldWorkerSlots > 0) {
    bits.push(`${sibling.heldWorkerSlots} slot(s)`);
  }
  return bits.join(" · ");
}

function shortLeaseStatus(lease: CoordinatorLeaseHealthObservation): string {
  switch (lease.status) {
    case "held":
      return lease.heldByUs ? "held" : "other";
    case "lost":
      return "lost";
    case "absent":
      return "absent";
    case "unavailable":
      return "n/a";
  }
}

function shortTargetLeaseStatus(lease: TargetBranchLeaseObservation): string {
  switch (lease.status) {
    case "held-by-us":
      return lease.phase ? `ours/${lease.phase}` : "ours";
    case "held-by-other":
      return typeof lease.workflowId === "number"
        ? `other/#${lease.workflowId}`
        : "other";
    case "absent":
      return "absent";
    case "expired":
      return "expired";
    case "lost":
      return "lost";
  }
}

function copyTarget(target: CanonicalTargetIdentity): CanonicalTargetIdentity {
  return {
    repository: { ...target.repository },
    targetRef: target.targetRef,
  };
}

function copyQueueCandidate(
  candidate: TargetBranchQueueCandidate,
): TargetBranchQueueCandidate {
  switch (candidate.state) {
    case "awaiting-pr-checks":
      return { state: "awaiting-pr-checks" };
    case "merge-ready":
      return { state: "merge-ready", mergeReadyAt: candidate.mergeReadyAt };
    case "refreshing":
      return candidate.mergeReadyAt
        ? { state: "refreshing", mergeReadyAt: candidate.mergeReadyAt }
        : { state: "refreshing" };
    case "retryable":
      return { state: "retryable", retry: { ...candidate.retry } };
    case "transient-retry":
      return { state: "transient-retry", retry: { ...candidate.retry } };
    case "merged":
      return { state: "merged" };
  }
}
