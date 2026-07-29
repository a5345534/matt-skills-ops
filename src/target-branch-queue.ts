import {
  canonicalTargetIdentitiesEqual,
  isCanonicalTargetIdentity,
} from "./coordination.js";
import type { CoordinationPort } from "./ports.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  CiStatus,
  CoordinationWorkflowManifest,
  TargetBranchLease,
  TargetBranchQueueCandidate,
  TransientWorkflowQueueRetry,
  WorkflowCoordinatorLease,
  WorkflowLeaseGenerationReferences,
  WorkflowManifest,
  WorkflowPrFreshness,
  WorkflowQueueRetry,
} from "./types.js";

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Conservative default retry budget for transient target-delivery failures. */
export const DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_ATTEMPTS = 3;
/** Initial delay used by exponential transient target-delivery retry backoff. */
export const DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_BASE_BACKOFF_MS = 1_000;
/** Upper bound for a single transient target-delivery retry delay. */
export const DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_BACKOFF_MS = 5 * 60_000;

/** One merge-ready workflow in the reconstructed Target-branch FIFO queue. */
export type TargetBranchQueueEntry = {
  workflowId: number;
  workflowPrNumber: number;
  headSha: string;
  mergeReadyAt: string;
};

/** Deterministic, read-only reconstruction of one Target branch's ready queue. */
export type TargetBranchQueueSnapshot = {
  target: CanonicalTargetIdentity;
  /** FIFO entries only; non-ready candidates deliberately do not appear here. */
  entries: readonly TargetBranchQueueEntry[];
};

/** An on-demand check observation for the exact Workflow PR head being evaluated. */
export type TargetBranchPrCheckObservation = {
  /** Exact PR head SHA on which the required checks ran. */
  headSha: string;
  /** `success` means every required check for this head passed. */
  status: CiStatus;
};

/** How a target-delivery failure should influence automatic recovery. */
export type TargetBranchQueueFailureKind = "transient" | "deterministic";

/** Bounded exponential-backoff policy for transient target-delivery failures. */
export type TargetBranchQueueRetryPolicy = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs?: number;
};

/** Critical Target-branch work performed while the serial lease is held. */
export type TargetBranchLeasePhase =
  | "refresh"
  | "validation"
  | "pr-update"
  | "merge";

/** Tracker operations required to reconstruct and persist per-workflow queue facts. */
export type TargetBranchQueueStore = {
  /** Must return every Active workflow for the canonical Target identity. */
  listActiveWorkflows(
    target: CanonicalTargetIdentity,
  ): Promise<readonly ActiveWorkflow[]>;
  /** Writes only the owning workflow's managed manifest. */
  writeWorkflowManifest(
    workflowId: number,
    manifest: WorkflowManifest,
  ): Promise<void>;
};

export type TargetBranchQueueOperationCode =
  | "workflow-not-active"
  | "workflow-not-coordinated"
  | "workflow-authority-lost"
  | "target-lease-not-held"
  | "target-lease-lost"
  | "target-lease-held"
  | "not-merge-ready"
  | "not-queue-head"
  | "invalid-phase"
  | "retry-not-due"
  | "not-retryable"
  | "persistence-failed"
  | "store-read-failed"
  | "coordination-failed";

export type TargetBranchQueueOperationAction =
  | "observed-pr-checks"
  | "target-lease-acquired"
  | "released-for-pr-checks"
  | "failure-recorded"
  | "retry-requeued"
  | "merged"
  | "expired-lease-recovered"
  | "target-lease-renewed"
  | "target-lease-released";

export type TargetBranchQueueOperationSuccess = {
  ok: true;
  action: TargetBranchQueueOperationAction;
  candidate?: TargetBranchQueueCandidate;
  queue?: TargetBranchQueueSnapshot;
  lease?: TargetBranchLease;
  phase?: TargetBranchLeasePhase;
};

export type TargetBranchQueueOperationFailure = {
  ok: false;
  code: TargetBranchQueueOperationCode;
  reason: string;
  queue?: TargetBranchQueueSnapshot;
  position?: number;
  lease?: TargetBranchLease;
  candidate?: TargetBranchQueueCandidate;
};

export type TargetBranchQueueOperationResult =
  | TargetBranchQueueOperationSuccess
  | TargetBranchQueueOperationFailure;

export type TargetBranchQueueOrchestratorOptions = {
  target: CanonicalTargetIdentity;
  workflowId: number;
  /** Stable identity of this live Workflow home process. */
  holderId: string;
  coordination: CoordinationPort;
  store: TargetBranchQueueStore;
  /** Injectable clock keeps queue timestamps and retry recovery deterministic. */
  now?: () => Date;
  retryPolicy?: Partial<TargetBranchQueueRetryPolicy>;
};

/** One domain command accepted by the queue orchestration module. */
export type TargetBranchQueueCommand =
  | {
      kind: "observe-pr-checks";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
      observation: TargetBranchPrCheckObservation;
    }
  | {
      kind: "acquire-phase";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
      phase: TargetBranchLeasePhase;
      ttlMs?: number;
    }
  | {
      kind: "release-for-pr-checks";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
      /** Updated only after a refresh/validation/PR update has changed PR facts. */
      prFreshness?: WorkflowPrFreshness;
      /**
       * When true (no required status checks on Target), re-admit merge-ready
       * immediately instead of awaiting PR-check observation that will never run.
       */
      admitMergeReady?: boolean;
    }
  | {
      kind: "record-failure";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
      failureKind: TargetBranchQueueFailureKind;
      reason: string;
      retryPolicy?: Partial<TargetBranchQueueRetryPolicy>;
    }
  | {
      kind: "requeue-retry";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
      retryKind: "transient" | "deterministic";
    }
  | {
      kind: "mark-merged";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
    }
  | {
      kind: "recover-expired-target-lease";
      workflowCoordinatorLease: WorkflowCoordinatorLease;
    }
  | { kind: "renew-held-target-lease"; ttlMs?: number }
  | { kind: "release-held-target-lease" };

/**
 * The queue module's Interface: one transition command plus a diagnostic lease
 * snapshot. Its implementation owns queue reconstruction, fencing, manifest
 * persistence, retry policy, and best-effort release behavior.
 */
export type TargetBranchQueueOrchestrator = {
  /** A copy of the lease held by this in-memory orchestration instance, if any. */
  getHeldTargetBranchLease(): TargetBranchLease | undefined;
  transition(
    command: TargetBranchQueueCommand,
  ): Promise<TargetBranchQueueOperationResult>;
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return false;
  const time = Date.parse(value);
  // Match the manifest parser: ISO strings may omit fractional seconds, while
  // newly persisted queue facts are normalized with milliseconds.
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

function checkedNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Target-branch queue clock returned an invalid Date.");
  }
  return new Date(value.getTime());
}

function copyTarget(target: CanonicalTargetIdentity): CanonicalTargetIdentity {
  return {
    repository: { ...target.repository },
    targetRef: target.targetRef,
  };
}

function copyRetry(retry: WorkflowQueueRetry): WorkflowQueueRetry {
  return { ...retry };
}

function copyCandidate(
  candidate: TargetBranchQueueCandidate,
): TargetBranchQueueCandidate {
  switch (candidate.state) {
    case "awaiting-pr-checks":
      return { state: "awaiting-pr-checks" };
    case "merge-ready":
      return { state: "merge-ready", mergeReadyAt: candidate.mergeReadyAt };
    case "refreshing":
      return {
        state: "refreshing",
        ...(candidate.mergeReadyAt
          ? { mergeReadyAt: candidate.mergeReadyAt }
          : {}),
      };
    case "retryable":
      return { state: "retryable", retry: copyRetry(candidate.retry) };
    case "transient-retry":
      return {
        state: "transient-retry",
        retry: { ...candidate.retry },
      };
    case "merged":
      return { state: "merged" };
  }
}

function candidatesEqual(
  left: TargetBranchQueueCandidate | undefined,
  right: TargetBranchQueueCandidate,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function copyPrFreshness(
  freshness: WorkflowPrFreshness,
): WorkflowPrFreshness {
  return {
    headSha: freshness.headSha,
    mergeMethod: freshness.mergeMethod,
    ...(freshness.validatedTargetSha
      ? { validatedTargetSha: freshness.validatedTargetSha }
      : {}),
  };
}

function isWorkflowPrFreshness(value: unknown): value is WorkflowPrFreshness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const freshness = value as Record<string, unknown>;
  if (
    !isGitObjectId(freshness.headSha) ||
    (freshness.mergeMethod !== "merge" &&
      freshness.mergeMethod !== "squash" &&
      freshness.mergeMethod !== "rebase")
  ) {
    return false;
  }
  return (
    freshness.validatedTargetSha === undefined ||
    isGitObjectId(freshness.validatedTargetSha)
  );
}

function copyActiveWithCandidate(
  active: ActiveWorkflow,
  candidate: TargetBranchQueueCandidate,
  prFreshness?: WorkflowPrFreshness,
): ActiveWorkflow {
  if (!active.coordination) return active;
  const freshness = prFreshness ?? active.coordination.prFreshness;
  return {
    ...active,
    workerProfile: { ...active.workerProfile },
    ...(active.tickets ? { tickets: [...active.tickets] } : {}),
    ...(active.integrationBranch
      ? { integrationBranch: active.integrationBranch }
      : {}),
    ...(active.integratedTickets
      ? { integratedTickets: active.integratedTickets.map((ticket) => ({ ...ticket })) }
      : {}),
    ...(active.workflowPr ? { workflowPr: { ...active.workflowPr } } : {}),
    coordination: {
      target: copyTarget(active.coordination.target),
      ...(freshness ? { prFreshness: copyPrFreshness(freshness) } : {}),
      queueCandidate: copyCandidate(candidate),
      ...(active.coordination.observedLeaseGenerations
        ? {
            observedLeaseGenerations: {
              ...active.coordination.observedLeaseGenerations,
            },
          }
        : {}),
    },
  };
}

function failure(
  code: TargetBranchQueueOperationCode,
  reason: string,
): TargetBranchQueueOperationFailure {
  return { ok: false, code, reason };
}

function retryAttempt(
  candidate: TargetBranchQueueCandidate | undefined,
  reason: string,
): number {
  if (
    candidate?.state === "retryable" &&
    candidate.retry.reason === reason
  ) {
    return candidate.retry.attempt + 1;
  }
  if (
    candidate?.state === "transient-retry" &&
    candidate.retry.reason === reason
  ) {
    return candidate.retry.attempt + 1;
  }
  return 1;
}

function normalizeRetryPolicy(
  policy: Partial<TargetBranchQueueRetryPolicy> | undefined,
): Required<TargetBranchQueueRetryPolicy> {
  const maxAttempts =
    policy?.maxAttempts ?? DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_ATTEMPTS;
  const baseBackoffMs =
    policy?.baseBackoffMs ?? DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_BASE_BACKOFF_MS;
  const maxBackoffMs =
    policy?.maxBackoffMs ?? DEFAULT_TARGET_BRANCH_TRANSIENT_RETRY_MAX_BACKOFF_MS;
  if (
    !isPositiveInteger(maxAttempts) ||
    !isPositiveInteger(baseBackoffMs) ||
    !isPositiveInteger(maxBackoffMs)
  ) {
    throw new Error(
      "Target-branch transient retry policy values must be positive safe integers.",
    );
  }
  return { maxAttempts, baseBackoffMs, maxBackoffMs };
}

function transientBackoffMs(
  attempt: number,
  policy: Required<TargetBranchQueueRetryPolicy>,
): number {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  const raw = policy.baseBackoffMs * multiplier;
  return Math.min(
    policy.maxBackoffMs,
    Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : policy.maxBackoffMs,
  );
}

/**
 * Reconstruct the only FIFO ordering authority: current merge-ready facts on
 * Active workflow manifests. No mutable central comment or local queue state
 * participates in this calculation.
 */
export function reconstructTargetBranchQueue(
  target: CanonicalTargetIdentity,
  workflows: readonly ActiveWorkflow[],
): TargetBranchQueueSnapshot {
  const entries: TargetBranchQueueEntry[] = [];
  if (!isCanonicalTargetIdentity(target)) {
    return { target: copyTarget(target), entries };
  }

  const seen = new Set<number>();
  for (const workflow of workflows) {
    if (
      !isPositiveInteger(workflow.workflowId) ||
      seen.has(workflow.workflowId) ||
      workflow.stage !== "pr-opened" ||
      !workflow.workflowPr ||
      !workflow.coordination ||
      !canonicalTargetIdentitiesEqual(workflow.coordination.target, target)
    ) {
      continue;
    }
    const freshness = workflow.coordination.prFreshness;
    const candidate = workflow.coordination.queueCandidate;
    if (
      !freshness ||
      !isGitObjectId(freshness.headSha) ||
      candidate?.state !== "merge-ready" ||
      !isIsoInstant(candidate.mergeReadyAt)
    ) {
      continue;
    }
    seen.add(workflow.workflowId);
    entries.push({
      workflowId: workflow.workflowId,
      workflowPrNumber: workflow.workflowPr.number,
      headSha: freshness.headSha,
      mergeReadyAt: candidate.mergeReadyAt,
    });
  }

  entries.sort((left, right) => {
    const timestampDifference =
      Date.parse(left.mergeReadyAt) - Date.parse(right.mergeReadyAt);
    return timestampDifference !== 0
      ? timestampDifference
      : left.workflowId - right.workflowId;
  });
  return { target: copyTarget(target), entries };
}

/** Return one-based FIFO position, or undefined when a workflow is not merge-ready. */
export function targetBranchQueuePosition(
  snapshot: TargetBranchQueueSnapshot,
  workflowId: number,
): number | undefined {
  const index = snapshot.entries.findIndex(
    (entry) => entry.workflowId === workflowId,
  );
  return index < 0 ? undefined : index + 1;
}

/**
 * Derive a candidate state from an exact-head required-check observation.
 * A stale observation is indistinguishable from pending for queue purposes:
 * neither may retain a merge-ready position. Deterministic retryable states
 * deliberately require explicit recovery before checks can re-admit them.
 */
export function transitionTargetBranchQueueForPrChecks(input: {
  candidate?: TargetBranchQueueCandidate;
  prFreshness: WorkflowPrFreshness;
  observation: TargetBranchPrCheckObservation;
  now: Date;
}): TargetBranchQueueCandidate {
  const previous = input.candidate;
  if (previous?.state === "merged") return copyCandidate(previous);
  if (
    previous?.state === "retryable" ||
    previous?.state === "transient-retry"
  ) {
    return copyCandidate(previous);
  }

  const observedCurrentHead =
    isGitObjectId(input.prFreshness.headSha) &&
    isGitObjectId(input.observation.headSha) &&
    input.prFreshness.headSha.toLowerCase() ===
      input.observation.headSha.toLowerCase();
  if (!observedCurrentHead || input.observation.status === "pending") {
    return { state: "awaiting-pr-checks" };
  }
  if (input.observation.status === "failure") {
    const reason = "required-pr-checks-failed";
    return {
      state: "retryable",
      retry: {
        reason,
        attempt: retryAttempt(previous, reason),
        failedAt: checkedNow(() => input.now).toISOString(),
      },
    };
  }
  if (input.observation.status !== "success") {
    return { state: "awaiting-pr-checks" };
  }
  if (previous?.state === "merge-ready" && isIsoInstant(previous.mergeReadyAt)) {
    return copyCandidate(previous);
  }
  return {
    state: "merge-ready",
    mergeReadyAt: checkedNow(() => input.now).toISOString(),
  };
}

/**
 * Build a retryable candidate. Transient failures receive a bounded exponential
 * backoff; exhaust their budget and they fail closed as deterministic retryable
 * work until an operator explicitly retries the workflow.
 */
export function recordTargetBranchQueueFailure(input: {
  candidate?: TargetBranchQueueCandidate;
  kind: TargetBranchQueueFailureKind;
  reason: string;
  now: Date;
  retryPolicy?: Partial<TargetBranchQueueRetryPolicy>;
}): TargetBranchQueueCandidate {
  if (!isNonEmptyString(input.reason)) {
    throw new Error("Target-branch queue failures require a non-empty reason.");
  }
  if (input.kind !== "transient" && input.kind !== "deterministic") {
    throw new Error("Target-branch queue failures must be transient or deterministic.");
  }
  if (input.candidate?.state === "merged") {
    return copyCandidate(input.candidate);
  }
  const failedAt = checkedNow(() => input.now).toISOString();
  const attempt = retryAttempt(input.candidate, input.reason);
  if (input.kind === "deterministic") {
    return {
      state: "retryable",
      retry: { reason: input.reason, attempt, failedAt },
    };
  }

  let policy = normalizeRetryPolicy(input.retryPolicy);
  // The manifest's existing retry budget is authoritative for an in-flight
  // sequence. A later caller cannot silently extend a bounded retry loop.
  if (
    input.candidate?.state === "transient-retry" &&
    input.candidate.retry.reason === input.reason
  ) {
    policy = {
      ...policy,
      maxAttempts: Math.min(policy.maxAttempts, input.candidate.retry.maxAttempts),
    };
  }
  if (attempt > policy.maxAttempts) {
    return {
      state: "retryable",
      retry: {
        reason: `transient-retry-exhausted:${input.reason}`,
        attempt,
        failedAt,
      },
    };
  }
  const nextRetryAt = new Date(
    checkedNow(() => input.now).getTime() + transientBackoffMs(attempt, policy),
  );
  const retry: TransientWorkflowQueueRetry = {
    reason: input.reason,
    attempt,
    maxAttempts: policy.maxAttempts,
    failedAt,
    nextRetryAt: nextRetryAt.toISOString(),
  };
  return { state: "transient-retry", retry };
}

/**
 * Remove a retry outcome only when recovery is allowed. A deterministic failure
 * needs an explicit operator-directed retry; a transient failure waits for its
 * recorded backoff deadline. Either path returns to checks and therefore gains
 * a new FIFO timestamp only after the current PR head is green again.
 */
export function requeueTargetBranchQueueCandidate(input: {
  candidate: TargetBranchQueueCandidate;
  now: Date;
  explicitDeterministicRetry?: boolean;
}): {
  candidate: TargetBranchQueueCandidate;
  requeued: boolean;
  reason?: "not-retryable" | "retry-not-due" | "explicit-retry-required";
} {
  const candidate = input.candidate;
  if (candidate.state === "transient-retry") {
    if (
      !isIsoInstant(candidate.retry.nextRetryAt) ||
      Date.parse(candidate.retry.nextRetryAt) > checkedNow(() => input.now).getTime()
    ) {
      return {
        candidate: copyCandidate(candidate),
        requeued: false,
        reason: "retry-not-due",
      };
    }
    return { candidate: { state: "awaiting-pr-checks" }, requeued: true };
  }
  if (candidate.state === "retryable") {
    if (!input.explicitDeterministicRetry) {
      return {
        candidate: copyCandidate(candidate),
        requeued: false,
        reason: "explicit-retry-required",
      };
    }
    return { candidate: { state: "awaiting-pr-checks" }, requeued: true };
  }
  return {
    candidate: copyCandidate(candidate),
    requeued: false,
    reason: "not-retryable",
  };
}

/**
 * Build the owning version-2 manifest for one persisted candidate transition.
 * This intentionally mutates no sibling facts and is the sole manifest shape
 * the queue orchestrator writes.
 */
function coordinationManifestWithTargetBranchQueueCandidate(input: {
  active: ActiveWorkflow;
  candidate: TargetBranchQueueCandidate;
  prFreshness?: WorkflowPrFreshness;
  observedLeaseGenerations: WorkflowLeaseGenerationReferences;
}): CoordinationWorkflowManifest | undefined {
  const { active } = input;
  if (!active.coordination || !active.workflowPr) return undefined;
  const prFreshness = input.prFreshness ?? active.coordination.prFreshness;
  if (!prFreshness || !isWorkflowPrFreshness(prFreshness)) return undefined;

  const manifest: CoordinationWorkflowManifest = {
    schema: "matt-auto/workflow-manifest",
    version: 2,
    workflowId: active.workflowId,
    targetBranch: active.targetBranch,
    stage: active.stage,
    workerProfile: { ...active.workerProfile },
    workflowPr: { ...active.workflowPr },
    coordination: {
      target: copyTarget(active.coordination.target),
      prFreshness: copyPrFreshness(prFreshness),
      queueCandidate: copyCandidate(input.candidate),
      ...(Object.keys(input.observedLeaseGenerations).length > 0
        ? {
            observedLeaseGenerations: {
              ...input.observedLeaseGenerations,
            },
          }
        : {}),
    },
  };
  if (active.tickets) manifest.tickets = [...active.tickets];
  if (active.integrationBranch) {
    manifest.integrationBranch = active.integrationBranch;
  }
  if (active.integratedTickets) {
    manifest.integratedTickets = active.integratedTickets.map((ticket) => ({
      ...ticket,
    }));
  }
  if (active.followUpOf !== undefined) manifest.followUpOf = active.followUpOf;
  return manifest;
}

/**
 * Fenced, per-workflow target-delivery orchestration. It never owns a central
 * queue record: every transition reads Active manifests, writes only its owning
 * manifest under a Workflow coordinator lease, and uses the Target lease only
 * for refresh, validation, PR update, and merge work.
 */
export function createTargetBranchQueueOrchestrator(
  options: TargetBranchQueueOrchestratorOptions,
): TargetBranchQueueOrchestrator {
  if (!isCanonicalTargetIdentity(options.target)) {
    throw new Error("Target-branch queue orchestration requires a canonical Target identity.");
  }
  if (!isPositiveInteger(options.workflowId)) {
    throw new Error("Target-branch queue orchestration requires a positive Workflow ID.");
  }
  if (!isNonEmptyString(options.holderId)) {
    throw new Error("Target-branch queue orchestration requires a non-empty holder ID.");
  }

  const target = copyTarget(options.target);
  const now = options.now ?? (() => new Date());
  const retryPolicy = normalizeRetryPolicy(options.retryPolicy);
  let heldTargetLease: TargetBranchLease | undefined;
  /** Prevent concurrent commands in one Workflow home from racing its manifest. */
  let transitionMutex: Promise<void> = Promise.resolve();

  function copyLease(lease: TargetBranchLease): TargetBranchLease {
    return {
      ...lease,
      scope: { target: copyTarget(lease.scope.target) },
    };
  }

  function workflowMatchesTarget(active: ActiveWorkflow): boolean {
    return Boolean(
      active.coordination &&
        canonicalTargetIdentitiesEqual(active.coordination.target, target),
    );
  }

  async function loadOwnWorkflow(): Promise<
    | { ok: true; workflows: readonly ActiveWorkflow[]; active: ActiveWorkflow }
    | TargetBranchQueueOperationFailure
  > {
    let workflows: readonly ActiveWorkflow[];
    try {
      workflows = await options.store.listActiveWorkflows(copyTarget(target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure("store-read-failed", `Could not reconstruct Target-branch queue: ${message}`);
    }
    const active = workflows.find(
      (workflow) => workflow.workflowId === options.workflowId,
    );
    if (!active) {
      return failure(
        "workflow-not-active",
        `Workflow #${options.workflowId} is not an Active workflow for this Target branch.`,
      );
    }
    if (!workflowMatchesTarget(active) || !active.coordination) {
      return failure(
        "workflow-not-coordinated",
        `Workflow #${options.workflowId} is not a coordination-aware workflow for this Target branch.`,
      );
    }
    return { ok: true, workflows, active };
  }

  function matchesWorkflowAuthority(lease: WorkflowCoordinatorLease): boolean {
    return (
      lease.kind === "workflow-coordinator" &&
      lease.holderId === options.holderId &&
      lease.scope.workflowId === options.workflowId &&
      canonicalTargetIdentitiesEqual(lease.scope.target, target)
    );
  }

  async function verifyWorkflowAuthority(
    lease: WorkflowCoordinatorLease,
  ): Promise<
    | { ok: true; lease: WorkflowCoordinatorLease }
    | TargetBranchQueueOperationFailure
  > {
    if (!matchesWorkflowAuthority(lease)) {
      return failure(
        "workflow-authority-lost",
        `Workflow #${options.workflowId} coordinator authority does not belong to this Workflow home.`,
      );
    }
    try {
      const verified = await options.coordination.verifyLease(lease);
      if (!verified.valid || verified.lease.kind !== "workflow-coordinator") {
        return failure(
          "workflow-authority-lost",
          `Workflow #${options.workflowId} coordinator lease is no longer valid (${verified.valid ? "unexpected lease kind" : verified.reason}).`,
        );
      }
      if (!matchesWorkflowAuthority(verified.lease)) {
        return failure(
          "workflow-authority-lost",
          `Workflow #${options.workflowId} coordinator lease no longer belongs to this Workflow home.`,
        );
      }
      return { ok: true, lease: verified.lease };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not verify Workflow #${options.workflowId} coordinator lease: ${message}`,
      );
    }
  }

  function matchesTargetAuthority(lease: TargetBranchLease): boolean {
    return (
      lease.kind === "target-branch" &&
      lease.holderId === options.holderId &&
      lease.workflowId === options.workflowId &&
      canonicalTargetIdentitiesEqual(lease.scope.target, target)
    );
  }

  async function verifyTargetAuthority(
    lease = heldTargetLease,
  ): Promise<
    | { ok: true; lease: TargetBranchLease }
    | TargetBranchQueueOperationFailure
  > {
    if (!lease || !matchesTargetAuthority(lease)) {
      return failure(
        "target-lease-not-held",
        `Workflow #${options.workflowId} does not hold the Target-branch lease.`,
      );
    }
    try {
      const verified = await options.coordination.verifyLease(lease);
      if (!verified.valid || verified.lease.kind !== "target-branch") {
        heldTargetLease = undefined;
        return failure(
          "target-lease-lost",
          `Target-branch lease is no longer valid (${verified.valid ? "unexpected lease kind" : verified.reason}).`,
        );
      }
      if (!matchesTargetAuthority(verified.lease)) {
        heldTargetLease = undefined;
        return failure(
          "target-lease-lost",
          "Target-branch lease is now held by another workflow or Workflow home.",
        );
      }
      heldTargetLease = copyLease(verified.lease);
      return { ok: true, lease: heldTargetLease };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not verify Target-branch lease: ${message}`,
      );
    }
  }

  function queueAfterCandidate(
    workflows: readonly ActiveWorkflow[],
    active: ActiveWorkflow,
    candidate: TargetBranchQueueCandidate,
    prFreshness?: WorkflowPrFreshness,
  ): TargetBranchQueueSnapshot {
    return reconstructTargetBranchQueue(
      target,
      workflows.map((workflow) =>
        workflow.workflowId === active.workflowId
          ? copyActiveWithCandidate(workflow, candidate, prFreshness)
          : workflow,
      ),
    );
  }

  async function persistCandidate(input: {
    active: ActiveWorkflow;
    candidate: TargetBranchQueueCandidate;
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    targetLease?: TargetBranchLease;
    prFreshness?: WorkflowPrFreshness;
  }): Promise<
    | {
        ok: true;
        workflowLease: WorkflowCoordinatorLease;
        targetLease?: TargetBranchLease;
      }
    | TargetBranchQueueOperationFailure
  > {
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) return workflowAuthority;

    let verifiedTargetLease: TargetBranchLease | undefined;
    if (input.targetLease) {
      const targetAuthority = await verifyTargetAuthority(input.targetLease);
      if (!targetAuthority.ok) return targetAuthority;
      verifiedTargetLease = targetAuthority.lease;
    }
    const observedLeaseGenerations: WorkflowLeaseGenerationReferences = {
      ...input.active.coordination?.observedLeaseGenerations,
      workflowCoordinator: workflowAuthority.lease.generation,
      ...(verifiedTargetLease
        ? { targetBranch: verifiedTargetLease.generation }
        : {}),
    };
    const manifest = coordinationManifestWithTargetBranchQueueCandidate({
      active: input.active,
      candidate: input.candidate,
      ...(input.prFreshness ? { prFreshness: input.prFreshness } : {}),
      observedLeaseGenerations,
    });
    if (!manifest) {
      return failure(
        "workflow-not-coordinated",
        `Workflow #${options.workflowId} has no valid coordination PR freshness facts to persist a queue candidate.`,
      );
    }
    try {
      await options.store.writeWorkflowManifest(options.workflowId, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "persistence-failed",
        `Could not persist Target-branch queue facts for Workflow #${options.workflowId}: ${message}`,
      );
    }
    return {
      ok: true,
      workflowLease: workflowAuthority.lease,
      ...(verifiedTargetLease ? { targetLease: verifiedTargetLease } : {}),
    };
  }

  async function releaseVerifiedTargetLease(
    lease: TargetBranchLease,
  ): Promise<TargetBranchQueueOperationFailure | undefined> {
    try {
      const released = await options.coordination.releaseLease(lease);
      heldTargetLease = undefined;
      if (released.released) return undefined;
      return failure(
        released.reason === "contended" ? "coordination-failed" : "target-lease-lost",
        `Could not release Target-branch lease (${released.reason}).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not release Target-branch lease: ${message}`,
      );
    }
  }

  /** A failed closed transition must never intentionally pin the serial lane. */
  async function releaseHeldTargetLeaseAfterFailure(): Promise<void> {
    const lease = heldTargetLease;
    if (!lease) return;
    await releaseVerifiedTargetLease(lease);
  }

  async function observePrChecks(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    observation: TargetBranchPrCheckObservation;
  }): Promise<TargetBranchQueueOperationResult> {
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) {
      await releaseHeldTargetLeaseAfterFailure();
      return loaded;
    }
    const freshness = loaded.active.coordination?.prFreshness;
    if (!freshness) {
      return failure(
        "workflow-not-coordinated",
        `Workflow #${options.workflowId} has no PR freshness facts for a queue-check transition.`,
      );
    }
    const previous = loaded.active.coordination?.queueCandidate;
    const candidate = transitionTargetBranchQueueForPrChecks({
      ...(previous ? { candidate: previous } : {}),
      prFreshness: freshness,
      observation: input.observation,
      now: checkedNow(now),
    });
    const leavesRefreshing = previous?.state === "refreshing";
    if (candidatesEqual(previous, candidate)) {
      return {
        ok: true,
        action: "observed-pr-checks",
        candidate,
        queue: reconstructTargetBranchQueue(target, loaded.workflows),
      };
    }

    let targetLease: TargetBranchLease | undefined;
    if (leavesRefreshing) {
      const targetAuthority = await verifyTargetAuthority();
      if (!targetAuthority.ok) return targetAuthority;
      targetLease = targetAuthority.lease;
    }
    const persisted = await persistCandidate({
      active: loaded.active,
      candidate,
      workflowCoordinatorLease: input.workflowCoordinatorLease,
      ...(targetLease ? { targetLease } : {}),
    });
    if (!persisted.ok) {
      if (targetLease) await releaseVerifiedTargetLease(targetLease);
      return persisted;
    }
    if (targetLease) {
      const releaseFailure = await releaseVerifiedTargetLease(targetLease);
      if (releaseFailure) {
        return { ...releaseFailure, candidate };
      }
    }
    return {
      ok: true,
      action: "observed-pr-checks",
      candidate,
      queue: queueAfterCandidate(loaded.workflows, loaded.active, candidate),
    };
  }

  async function acquireForPhase(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    phase: TargetBranchLeasePhase;
    ttlMs?: number;
  }): Promise<TargetBranchQueueOperationResult> {
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) return workflowAuthority;
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) return loaded;
    const candidate = loaded.active.coordination?.queueCandidate;
    const missingValidatedTarget =
      !loaded.active.coordination?.prFreshness?.validatedTargetSha;
    // First-time Target refresh (no validatedTargetSha yet) may run from
    // awaiting-pr-checks so delivery is not blocked when PR checks never start.
    // Normal merge/refresh still requires merge-ready + FIFO head.
    const refreshBootstrap =
      input.phase === "refresh" &&
      missingValidatedTarget &&
      (candidate?.state === "awaiting-pr-checks" ||
        candidate?.state === "refreshing" ||
        candidate?.state === "merge-ready");
    if (candidate?.state !== "merge-ready" && !refreshBootstrap) {
      return failure(
        "not-merge-ready",
        `Workflow #${options.workflowId} is not merge-ready and cannot acquire the Target-branch lease.`,
      );
    }
    const queue = reconstructTargetBranchQueue(target, loaded.workflows);
    const position = targetBranchQueuePosition(queue, options.workflowId);
    if (candidate?.state === "merge-ready" && position !== 1) {
      return {
        ...failure(
          "not-queue-head",
          `Workflow #${options.workflowId} is waiting behind the FIFO Target-branch queue head.`,
        ),
        queue,
        ...(position ? { position } : {}),
      };
    }
    // Bootstrap refresh while not yet merge-ready: only when no other workflow
    // already owns the merge-ready FIFO head.
    if (
      refreshBootstrap &&
      candidate?.state !== "merge-ready" &&
      queue.entries.length > 0 &&
      queue.entries[0]?.workflowId !== options.workflowId
    ) {
      return {
        ...failure(
          "not-queue-head",
          `Workflow #${options.workflowId} is waiting behind the FIFO Target-branch queue head.`,
        ),
        queue,
        position: 1 + queue.entries.findIndex((e) => e.workflowId === options.workflowId),
      };
    }

    let acquired: Awaited<ReturnType<CoordinationPort["acquireLease"]>>;
    try {
      acquired = await options.coordination.acquireLease({
        kind: "target-branch",
        target: copyTarget(target),
        holderId: options.holderId,
        workflowId: options.workflowId,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not acquire Target-branch lease: ${message}`,
      );
    }
    if (!acquired.acquired || acquired.lease.kind !== "target-branch") {
      return {
        ...failure(
          "target-lease-held",
          "Another workflow currently owns the Target-branch delivery lane.",
        ),
        ...(!acquired.acquired && acquired.lease?.kind === "target-branch"
          ? { lease: copyLease(acquired.lease) }
          : {}),
      };
    }
    heldTargetLease = copyLease(acquired.lease);
    const targetAuthority = await verifyTargetAuthority(heldTargetLease);
    if (!targetAuthority.ok) return targetAuthority;

    // The lease race is resolved, but manifests may have changed while it was
    // acquired. Reconstruct again before transitioning this candidate.
    const reloaded = await loadOwnWorkflow();
    if (!reloaded.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return reloaded;
    }
    const currentCandidate = reloaded.active.coordination?.queueCandidate;
    const currentQueue = reconstructTargetBranchQueue(target, reloaded.workflows);
    const currentPosition = targetBranchQueuePosition(
      currentQueue,
      options.workflowId,
    );
    const currentMissingValidated =
      !reloaded.active.coordination?.prFreshness?.validatedTargetSha;
    const currentRefreshBootstrap =
      input.phase === "refresh" &&
      currentMissingValidated &&
      (currentCandidate?.state === "awaiting-pr-checks" ||
        currentCandidate?.state === "refreshing" ||
        currentCandidate?.state === "merge-ready");
    const stillEligible =
      (currentCandidate?.state === "merge-ready" && currentPosition === 1) ||
      (currentRefreshBootstrap &&
        (currentCandidate?.state === "merge-ready"
          ? currentPosition === 1
          : currentQueue.entries.length === 0 ||
            currentQueue.entries[0]?.workflowId === options.workflowId));
    if (!stillEligible) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return {
        ...failure(
          currentCandidate?.state === "merge-ready"
            ? "not-queue-head"
            : "not-merge-ready",
          `Workflow #${options.workflowId} changed while acquiring the Target-branch lease; the lane was released.`,
        ),
        queue: currentQueue,
        ...(currentPosition ? { position: currentPosition } : {}),
      };
    }

    const refreshing: TargetBranchQueueCandidate = { state: "refreshing" };
    const persisted = await persistCandidate({
      active: reloaded.active,
      candidate: refreshing,
      workflowCoordinatorLease: workflowAuthority.lease,
      targetLease: targetAuthority.lease,
    });
    if (!persisted.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return persisted;
    }
    const held = persisted.targetLease ?? targetAuthority.lease;
    heldTargetLease = copyLease(held);
    return {
      ok: true,
      action: "target-lease-acquired",
      candidate: refreshing,
      lease: copyLease(held),
      phase: input.phase,
    };
  }

  async function releaseForRemotePrChecks(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    prFreshness?: WorkflowPrFreshness;
    admitMergeReady?: boolean;
  }): Promise<TargetBranchQueueOperationResult> {
    // Check local lane ownership first so a different home cannot use another
    // workflow's coordinator lease to alter a refreshing candidate.
    const targetAuthority = await verifyTargetAuthority();
    if (!targetAuthority.ok) return targetAuthority;
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return workflowAuthority;
    }
    if (input.prFreshness && !isWorkflowPrFreshness(input.prFreshness)) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return failure(
        "invalid-phase",
        "Updated Workflow PR freshness must include a valid exact head SHA and merge method.",
      );
    }
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return loaded;
    }
    if (loaded.active.coordination?.queueCandidate?.state !== "refreshing") {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return failure(
        "invalid-phase",
        "Target-branch lease release for remote checks requires a refreshing candidate.",
      );
    }
    const nextCandidate: TargetBranchQueueCandidate = input.admitMergeReady
      ? {
          state: "merge-ready",
          mergeReadyAt: new Date().toISOString(),
        }
      : { state: "awaiting-pr-checks" };
    const persisted = await persistCandidate({
      active: loaded.active,
      candidate: nextCandidate,
      workflowCoordinatorLease: workflowAuthority.lease,
      targetLease: targetAuthority.lease,
      ...(input.prFreshness ? { prFreshness: input.prFreshness } : {}),
    });
    const releaseFailure = await releaseVerifiedTargetLease(targetAuthority.lease);
    if (!persisted.ok) return persisted;
    if (releaseFailure) return { ...releaseFailure, candidate: nextCandidate };
    return {
      ok: true,
      action: "released-for-pr-checks",
      candidate: nextCandidate,
      queue: queueAfterCandidate(
        loaded.workflows,
        loaded.active,
        nextCandidate,
        input.prFreshness,
      ),
    };
  }

  async function recordFailure(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    kind: TargetBranchQueueFailureKind;
    reason: string;
    retryPolicy?: Partial<TargetBranchQueueRetryPolicy>;
  }): Promise<TargetBranchQueueOperationResult> {
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) {
      await releaseHeldTargetLeaseAfterFailure();
      return workflowAuthority;
    }
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) {
      await releaseHeldTargetLeaseAfterFailure();
      return loaded;
    }

    let targetLease: TargetBranchLease | undefined;
    if (heldTargetLease) {
      const targetAuthority = await verifyTargetAuthority();
      if (!targetAuthority.ok) return targetAuthority;
      targetLease = targetAuthority.lease;
    }
    let candidate: TargetBranchQueueCandidate;
    try {
      candidate = recordTargetBranchQueueFailure({
        ...(loaded.active.coordination?.queueCandidate
          ? { candidate: loaded.active.coordination.queueCandidate }
          : {}),
        kind: input.kind,
        reason: input.reason,
        now: checkedNow(now),
        retryPolicy: {
          ...retryPolicy,
          ...input.retryPolicy,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (targetLease) await releaseVerifiedTargetLease(targetLease);
      return failure("invalid-phase", message);
    }
    const persisted = await persistCandidate({
      active: loaded.active,
      candidate,
      workflowCoordinatorLease: workflowAuthority.lease,
      ...(targetLease ? { targetLease } : {}),
    });
    const releaseFailure = targetLease
      ? await releaseVerifiedTargetLease(targetLease)
      : undefined;
    if (!persisted.ok) return persisted;
    if (releaseFailure) return { ...releaseFailure, candidate };
    return {
      ok: true,
      action: "failure-recorded",
      candidate,
      queue: queueAfterCandidate(loaded.workflows, loaded.active, candidate),
    };
  }

  async function requeueRetry(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
    kind: "transient" | "deterministic";
  }): Promise<TargetBranchQueueOperationResult> {
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) return workflowAuthority;
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) return loaded;
    const previous = loaded.active.coordination?.queueCandidate;
    if (!previous) {
      return failure(
        "not-retryable",
        `Workflow #${options.workflowId} has no Target-branch retry outcome to requeue.`,
      );
    }
    if (
      (input.kind === "transient" && previous.state !== "transient-retry") ||
      (input.kind === "deterministic" && previous.state !== "retryable")
    ) {
      return failure(
        "not-retryable",
        `Workflow #${options.workflowId} does not have a ${input.kind} Target-branch retry outcome.`,
      );
    }
    const requeued = requeueTargetBranchQueueCandidate({
      candidate: previous,
      now: checkedNow(now),
      ...(input.kind === "deterministic"
        ? { explicitDeterministicRetry: true }
        : {}),
    });
    if (!requeued.requeued) {
      return failure(
        requeued.reason === "retry-not-due" ? "retry-not-due" : "not-retryable",
        requeued.reason === "retry-not-due"
          ? "Transient Target-branch retry backoff has not elapsed."
          : "This Target-branch queue candidate requires a different recovery path.",
      );
    }
    const persisted = await persistCandidate({
      active: loaded.active,
      candidate: requeued.candidate,
      workflowCoordinatorLease: workflowAuthority.lease,
    });
    if (!persisted.ok) return persisted;
    return {
      ok: true,
      action: "retry-requeued",
      candidate: requeued.candidate,
      queue: queueAfterCandidate(
        loaded.workflows,
        loaded.active,
        requeued.candidate,
      ),
    };
  }

  async function markMerged(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
  }): Promise<TargetBranchQueueOperationResult> {
    const targetAuthority = await verifyTargetAuthority();
    if (!targetAuthority.ok) return targetAuthority;
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return workflowAuthority;
    }
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return loaded;
    }
    if (loaded.active.coordination?.queueCandidate?.state !== "refreshing") {
      await releaseVerifiedTargetLease(targetAuthority.lease);
      return failure(
        "invalid-phase",
        "Marking a Workflow PR merged requires the current Target-branch lease and refreshing state.",
      );
    }
    const merged: TargetBranchQueueCandidate = { state: "merged" };
    const persisted = await persistCandidate({
      active: loaded.active,
      candidate: merged,
      workflowCoordinatorLease: workflowAuthority.lease,
      targetLease: targetAuthority.lease,
    });
    const releaseFailure = await releaseVerifiedTargetLease(targetAuthority.lease);
    if (!persisted.ok) return persisted;
    if (releaseFailure) return { ...releaseFailure, candidate: merged };
    return { ok: true, action: "merged", candidate: merged };
  }

  async function recoverExpiredTargetLease(input: {
    workflowCoordinatorLease: WorkflowCoordinatorLease;
  }): Promise<TargetBranchQueueOperationResult> {
    const workflowAuthority = await verifyWorkflowAuthority(
      input.workflowCoordinatorLease,
    );
    if (!workflowAuthority.ok) return workflowAuthority;
    const loaded = await loadOwnWorkflow();
    if (!loaded.ok) return loaded;
    if (loaded.active.coordination?.queueCandidate?.state !== "refreshing") {
      return failure(
        "invalid-phase",
        "Expired Target-branch lease recovery applies only to a refreshing candidate.",
      );
    }

    let observed: TargetBranchLease | undefined;
    try {
      const lease = await options.coordination.getLease({
        kind: "target-branch",
        target: copyTarget(target),
      });
      observed = lease?.kind === "target-branch" ? lease : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not inspect Target-branch lease recovery state: ${message}`,
      );
    }
    const at = checkedNow(now).getTime();
    if (
      observed &&
      !observed.releasedAt &&
      Date.parse(observed.expiresAt) > at
    ) {
      return {
        ...failure(
          "target-lease-held",
          "The Target-branch lease is still live; refreshing recovery remains fenced.",
        ),
        lease: copyLease(observed),
      };
    }
    heldTargetLease = undefined;
    const recovered = await recordFailure({
      workflowCoordinatorLease: workflowAuthority.lease,
      kind: "transient",
      reason: "target-branch-lease-expired",
    });
    if (!recovered.ok) return recovered;
    return { ...recovered, action: "expired-lease-recovered" };
  }

  async function renewHeldTargetBranchLease(input?: {
    ttlMs?: number;
  }): Promise<TargetBranchQueueOperationResult> {
    const targetAuthority = await verifyTargetAuthority();
    if (!targetAuthority.ok) return targetAuthority;
    try {
      const renewed = await options.coordination.renewLease({
        lease: targetAuthority.lease,
        ...(input?.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      });
      if (!renewed.renewed || renewed.lease.kind !== "target-branch") {
        heldTargetLease = undefined;
        return failure(
          "target-lease-lost",
          `Target-branch lease could not be renewed (${renewed.renewed ? "unexpected lease kind" : renewed.reason}).`,
        );
      }
      if (!matchesTargetAuthority(renewed.lease)) {
        heldTargetLease = undefined;
        return failure(
          "target-lease-lost",
          "Target-branch lease renewal returned an unexpected holder or workflow.",
        );
      }
      heldTargetLease = copyLease(renewed.lease);
      return {
        ok: true,
        action: "target-lease-renewed",
        lease: copyLease(heldTargetLease),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        "coordination-failed",
        `Could not renew Target-branch lease: ${message}`,
      );
    }
  }

  async function releaseHeldTargetBranchLease(): Promise<TargetBranchQueueOperationResult> {
    const targetAuthority = await verifyTargetAuthority();
    if (!targetAuthority.ok) return targetAuthority;
    const releaseFailure = await releaseVerifiedTargetLease(targetAuthority.lease);
    if (releaseFailure) return releaseFailure;
    return { ok: true, action: "target-lease-released" };
  }

  async function applyTransition(
    command: TargetBranchQueueCommand,
  ): Promise<TargetBranchQueueOperationResult> {
    switch (command.kind) {
      case "observe-pr-checks":
        return observePrChecks({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
          observation: command.observation,
        });
      case "acquire-phase":
        return acquireForPhase({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
          phase: command.phase,
          ...(command.ttlMs !== undefined ? { ttlMs: command.ttlMs } : {}),
        });
      case "release-for-pr-checks":
        return releaseForRemotePrChecks({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
          ...(command.prFreshness
            ? { prFreshness: command.prFreshness }
            : {}),
          ...(command.admitMergeReady ? { admitMergeReady: true } : {}),
        });
      case "record-failure":
        return recordFailure({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
          kind: command.failureKind,
          reason: command.reason,
          ...(command.retryPolicy ? { retryPolicy: command.retryPolicy } : {}),
        });
      case "requeue-retry":
        return requeueRetry({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
          kind: command.retryKind,
        });
      case "mark-merged":
        return markMerged({ workflowCoordinatorLease: command.workflowCoordinatorLease });
      case "recover-expired-target-lease":
        return recoverExpiredTargetLease({
          workflowCoordinatorLease: command.workflowCoordinatorLease,
        });
      case "renew-held-target-lease":
        return renewHeldTargetBranchLease(
          command.ttlMs === undefined ? undefined : { ttlMs: command.ttlMs },
        );
      case "release-held-target-lease":
        return releaseHeldTargetBranchLease();
    }
  }

  async function transition(
    command: TargetBranchQueueCommand,
  ): Promise<TargetBranchQueueOperationResult> {
    const previous = transitionMutex;
    let unlock: (() => void) | undefined;
    transitionMutex = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await applyTransition(command);
    } finally {
      unlock?.();
    }
  }

  return {
    getHeldTargetBranchLease: () =>
      heldTargetLease ? copyLease(heldTargetLease) : undefined,
    transition,
  };
}
