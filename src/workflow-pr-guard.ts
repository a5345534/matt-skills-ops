import type {
  CanonicalRepositoryIdentity,
  CiStatus,
  PreflightCheck,
  TargetBranchLease,
  WorkflowMergeMethod,
} from "./types.js";

/** Stable machine-readable merge-time freshness failure codes. */
export const MERGE_FRESHNESS_FAILURE_CODES = {
  staleLease: "stale-lease",
  staleTargetSha: "stale-target-sha",
  unexpectedPrHead: "unexpected-pr-head",
  requiredChecksNotGreen: "required-checks-not-green",
  requiredChecksStaleHead: "required-checks-stale-head",
  missingValidatedTargetSha: "missing-validated-target-sha",
  missingPrFreshness: "missing-pr-freshness",
  missingMergeMethod: "missing-merge-method",
} as const;

export type MergeFreshnessFailureCode =
  (typeof MERGE_FRESHNESS_FAILURE_CODES)[keyof typeof MERGE_FRESHNESS_FAILURE_CODES];

/** How the Target-branch queue should recover after a failed merge freshness preflight. */
export type MergeFreshnessRecovery =
  /** Target advanced; release the lane and refresh before re-checking. */
  | "requeue-refresh"
  /** PR head or checks are not yet valid; wait for a new green observation. */
  | "awaiting-pr-checks"
  /** Deterministic policy/authority problem; explicit recovery required. */
  | "retryable";

/** Observed repository + branch policy used by Workflow preflight. */
export type ProtectedBranchAutomationPolicy = {
  /** Canonical GitHub owner/name, when resolved. */
  repository?: CanonicalRepositoryIdentity;
  /** Fully qualified Target ref, when known. */
  targetRef?: string;
  /** True when reserved coordination refs are writable by this home. */
  coordinationRefsWritable?: boolean;
  /**
   * Required status-check configuration. `strict: true` is the GitHub
   * "require branches to be up to date before merging" guarantee Matt Auto needs.
   */
  requiredStatusChecks?: {
    strict: boolean;
    contexts: readonly string[];
  };
  /** Approving reviews required by branch protection / rulesets. */
  requiredApprovingReviewCount?: number;
  /** Allowed merge methods from repository settings. Empty means none allowed. */
  allowedMergeMethods?: readonly WorkflowMergeMethod[];
  /**
   * Preferred method when more than one is allowed. Matt Auto records this on
   * PR freshness and never invents a hard-coded strategy.
   */
  preferredMergeMethod?: WorkflowMergeMethod;
  /** True when GitHub's native merge queue is the required delivery path. */
  mergeQueueRequired?: boolean;
  /**
   * True when the authenticated actor can merge without human approval or a
   * manual GitHub UI step.
   */
  actorCanMergeWithoutApproval?: boolean;
  /**
   * True when branch protection / rulesets reject stale-base merges (strict
   * required checks or an equivalent ruleset).
   */
  staleBaseProtectionGuaranteed?: boolean;
};

/** Merge-time facts checked immediately before automatic Workflow PR merge. */
export type MergeFreshnessInput = {
  /** Currently held Target-branch lease (must still verify). */
  heldLease: TargetBranchLease;
  /** Expected fencing generation for this holder. */
  expectedGeneration: number;
  /** Expected holder identity for this Workflow home. */
  expectedHolderId: string;
  /** Target SHA the refreshed PR head was validated against. */
  validatedTargetSha: string;
  /** Live Target tip observed immediately before merge. */
  currentTargetSha: string;
  /** Expected Workflow PR head recorded on the manifest. */
  expectedHeadSha: string;
  /** Live Workflow PR head observed immediately before merge. */
  currentHeadSha: string;
  /** Required-check observation for an exact head. */
  requiredChecks: {
    headSha: string;
    status: CiStatus;
  };
};

export type MergeFreshnessResult =
  | { ok: true }
  | {
      ok: false;
      code: MergeFreshnessFailureCode;
      reason: string;
      recovery: MergeFreshnessRecovery;
      failureKind: "transient" | "deterministic";
    };

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

export function sameGitObjectId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Choose the repository-configured merge method Matt Auto will use.
 * Never invents a strategy when the repository has not configured one.
 */
export function selectConfiguredMergeMethod(
  policy: ProtectedBranchAutomationPolicy,
): WorkflowMergeMethod | undefined {
  if (
    policy.preferredMergeMethod &&
    isAllowedMergeMethod(policy, policy.preferredMergeMethod)
  ) {
    return policy.preferredMergeMethod;
  }
  const allowed = policy.allowedMergeMethods ?? [];
  if (allowed.length === 1) return allowed[0];
  // Prefer squash → merge → rebase only as a deterministic tie-break among
  // explicitly allowed methods; still never invents an unconfigured method.
  for (const method of ["squash", "merge", "rebase"] as const) {
    if (allowed.includes(method)) return method;
  }
  return undefined;
}

function isAllowedMergeMethod(
  policy: ProtectedBranchAutomationPolicy,
  method: WorkflowMergeMethod,
): boolean {
  return (policy.allowedMergeMethods ?? []).includes(method);
}

/**
 * Evaluate protected-branch automation compatibility for Workflow preflight.
 * Fail-closes on manual approval, manual merge, unsupported merge methods,
 * native merge-queue requirements, missing coordination-ref permissions, or
 * stale-base protection that cannot be guaranteed.
 */
export function evaluateProtectedBranchAutomation(
  policy: ProtectedBranchAutomationPolicy,
): {
  ok: boolean;
  mergeMethod?: WorkflowMergeMethod;
  checks: PreflightCheck[];
} {
  const checks: PreflightCheck[] = [];

  const hasRepository =
    policy.repository !== undefined &&
    typeof policy.repository.owner === "string" &&
    policy.repository.owner.length > 0 &&
    typeof policy.repository.name === "string" &&
    policy.repository.name.length > 0;
  checks.push({
    id: "canonical-repository",
    ok: hasRepository,
    guidance: hasRepository
      ? `Canonical repository ${policy.repository!.owner}/${policy.repository!.name} is resolved.`
      : "Could not resolve the canonical GitHub repository owner/name for this Workflow root. Matt Auto will not invent a repository identity.",
  });

  const coordinationOk = policy.coordinationRefsWritable === true;
  checks.push({
    id: "coordination-refs",
    ok: coordinationOk,
    guidance: coordinationOk
      ? "Reserved coordination refs are writable by this Workflow home."
      : "Missing permission to update the reserved Matt Auto coordination-ref namespace. Grant push access for coordination refs (or use a token with that scope) and retry Workflow preflight. Matt Auto does not bootstrap repository permissions.",
  });

  const mergeMethod = selectConfiguredMergeMethod(policy);
  const mergeMethodOk = mergeMethod !== undefined;
  checks.push({
    id: "merge-method",
    ok: mergeMethodOk,
    guidance: mergeMethodOk
      ? `Repository-configured merge method is "${mergeMethod}".`
      : "No supported repository merge method is enabled (merge, squash, or rebase). Enable exactly the methods you intend Matt Auto to use; Matt Auto does not hard-code a merge strategy.",
  });

  const hasRequiredChecks =
    (policy.requiredStatusChecks?.contexts.length ?? 0) > 0;
  const strictChecks = policy.requiredStatusChecks?.strict === true;
  const staleBaseOk =
    policy.staleBaseProtectionGuaranteed === true ||
    (hasRequiredChecks && strictChecks);
  checks.push({
    id: "stale-base-protection",
    ok: staleBaseOk,
    guidance: staleBaseOk
      ? "Strict stale-base protection is guaranteed for the Target branch (required checks must pass on an up-to-date head)."
      : "Target branch does not guarantee strict stale-base protection. Enable required status checks with \"require branches to be up to date before merging\" (or an equivalent ruleset). Matt Auto will not partially automate merges without that guarantee.",
  });

  const requiredApprovals = policy.requiredApprovingReviewCount ?? 0;
  const mergeQueueOk = policy.mergeQueueRequired !== true;
  const actorOk = policy.actorCanMergeWithoutApproval === true;
  const authorityOk =
    mergeQueueOk && actorOk && requiredApprovals === 0 && staleBaseOk;
  let authorityGuidance: string;
  if (authorityOk) {
    authorityGuidance =
      "Authenticated identity can merge Workflow PRs non-interactively without manual approval.";
  } else if (!mergeQueueOk) {
    authorityGuidance =
      "Target branch requires GitHub's native merge queue, which is unsupported for Matt Auto automatic delivery. Use branch protection with required checks instead, or finish delivery manually.";
  } else if (requiredApprovals > 0) {
    authorityGuidance = `Target branch requires ${requiredApprovals} approving review(s). Matt Auto will not bypass review requirements; automatic merge is incompatible until required approvals are removed for the automation identity or delivery stays manual.`;
  } else if (!actorOk) {
    authorityGuidance =
      "Authenticated identity cannot merge Workflow PRs without human interaction. Grant merge permission to the automation identity and remove manual-only merge gates.";
  } else {
    authorityGuidance =
      "Protected-branch automation is incomplete: required-check / stale-base guarantees are missing, so non-interactive merge authority cannot be claimed.";
  }
  checks.push({
    id: "merge-authority",
    ok: authorityOk,
    guidance: authorityGuidance,
  });

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    checks,
    ...(mergeMethod ? { mergeMethod } : {}),
  };
}

/**
 * Immediate preflight before automatic Workflow PR merge.
 * Requires the current Target-branch lease fencing token, the refreshed target
 * SHA, the expected PR head SHA, and fresh required checks for that head.
 */
export function evaluateMergeFreshness(
  input: MergeFreshnessInput,
): MergeFreshnessResult {
  if (
    input.heldLease.holderId !== input.expectedHolderId ||
    input.heldLease.generation !== input.expectedGeneration ||
    input.heldLease.releasedAt !== undefined
  ) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.staleLease,
      reason:
        "Target-branch lease fencing token is stale or not held by this Workflow home; refusing automatic merge.",
      recovery: "retryable",
      failureKind: "transient",
    };
  }

  if (
    !isGitObjectId(input.validatedTargetSha) ||
    !isGitObjectId(input.currentTargetSha)
  ) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.missingValidatedTargetSha,
      reason:
        "Validated Target SHA and live Target SHA are required before automatic merge.",
      recovery: "requeue-refresh",
      failureKind: "deterministic",
    };
  }

  if (!sameGitObjectId(input.validatedTargetSha, input.currentTargetSha)) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.staleTargetSha,
      reason:
        "Target branch advanced after the refreshed Workflow PR head was validated; refresh and a new required-check cycle are required before merge.",
      recovery: "requeue-refresh",
      failureKind: "deterministic",
    };
  }

  if (
    !isGitObjectId(input.expectedHeadSha) ||
    !isGitObjectId(input.currentHeadSha)
  ) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.unexpectedPrHead,
      reason: "Workflow PR head SHAs are required before automatic merge.",
      recovery: "awaiting-pr-checks",
      failureKind: "deterministic",
    };
  }

  if (!sameGitObjectId(input.expectedHeadSha, input.currentHeadSha)) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.unexpectedPrHead,
      reason:
        "Workflow PR head differs from the expected refreshed head; refusing automatic merge.",
      recovery: "awaiting-pr-checks",
      failureKind: "deterministic",
    };
  }

  if (!sameGitObjectId(input.requiredChecks.headSha, input.expectedHeadSha)) {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksStaleHead,
      reason:
        "Required-check observation is not for the expected Workflow PR head; a new check cycle is required.",
      recovery: "awaiting-pr-checks",
      failureKind: "deterministic",
    };
  }

  if (input.requiredChecks.status === "pending") {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksNotGreen,
      reason:
        "Required checks are still pending for the expected Workflow PR head; refusing automatic merge.",
      recovery: "awaiting-pr-checks",
      failureKind: "transient",
    };
  }

  if (input.requiredChecks.status !== "success") {
    return {
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksNotGreen,
      reason:
        "Required checks are not green for the expected Workflow PR head; refusing automatic merge.",
      recovery: "retryable",
      failureKind: "deterministic",
    };
  }

  return { ok: true };
}

/** CLI flag for `gh pr merge` from a repository-configured method. */
export function mergeMethodCliFlag(
  method: WorkflowMergeMethod,
): "--merge" | "--squash" | "--rebase" {
  switch (method) {
    case "squash":
      return "--squash";
    case "rebase":
      return "--rebase";
    case "merge":
    default:
      return "--merge";
  }
}
