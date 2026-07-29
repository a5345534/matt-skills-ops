import { describe, expect, it } from "vitest";
import type { TargetBranchLease } from "../src/types.js";
import {
  evaluateMergeFreshness,
  evaluateProtectedBranchAutomation,
  MERGE_FRESHNESS_FAILURE_CODES,
  mergeMethodCliFlag,
  policyRequiresStatusChecks,
  selectConfiguredMergeMethod,
  type ProtectedBranchAutomationPolicy,
} from "../src/workflow-pr-guard.js";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const OTHER = "c".repeat(40);

function compatiblePolicy(
  overrides: Partial<ProtectedBranchAutomationPolicy> = {},
): ProtectedBranchAutomationPolicy {
  return {
    repository: { owner: "acme", name: "widgets" },
    targetRef: "refs/heads/main",
    coordinationRefsWritable: true,
    requiredStatusChecks: { strict: true, contexts: ["ci"] },
    requiredApprovingReviewCount: 0,
    allowedMergeMethods: ["squash", "merge"],
    preferredMergeMethod: "squash",
    mergeQueueRequired: false,
    actorCanMergeWithoutApproval: true,
    staleBaseProtectionGuaranteed: true,
    ...overrides,
  };
}

function heldLease(
  overrides: Partial<TargetBranchLease> = {},
): TargetBranchLease {
  return {
    kind: "target-branch",
    holderId: "home-1",
    generation: 3,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:30.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    scope: {
      target: {
        repository: { owner: "acme", name: "widgets" },
        targetRef: "refs/heads/main",
      },
    },
    ...overrides,
  };
}

describe("evaluateProtectedBranchAutomation", () => {
  it("passes when repository policy supports non-interactive delivery", () => {
    const result = evaluateProtectedBranchAutomation(compatiblePolicy());
    expect(result.ok).toBe(true);
    expect(result.mergeMethod).toBe("squash");
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("fail-closes on missing coordination-ref permissions", () => {
    const result = evaluateProtectedBranchAutomation(
      compatiblePolicy({ coordinationRefsWritable: false }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "coordination-refs")?.ok,
    ).toBe(false);
  });

  it("fail-closes when branch policy requires manual approval", () => {
    const result = evaluateProtectedBranchAutomation(
      compatiblePolicy({
        requiredApprovingReviewCount: 1,
        actorCanMergeWithoutApproval: false,
      }),
    );
    expect(result.ok).toBe(false);
    const authority = result.checks.find((check) => check.id === "merge-authority");
    expect(authority?.ok).toBe(false);
    expect(authority?.guidance).toMatch(/approving review/i);
  });

  it("fail-closes when no supported merge methods are enabled", () => {
    const policy = compatiblePolicy({ allowedMergeMethods: [] });
    delete (policy as { preferredMergeMethod?: string }).preferredMergeMethod;
    const result = evaluateProtectedBranchAutomation(policy);
    expect(result.ok).toBe(false);
    expect(result.mergeMethod).toBeUndefined();
    expect(result.checks.find((check) => check.id === "merge-method")?.ok).toBe(
      false,
    );
  });

  it("fail-closes on unsupported native merge-queue behavior", () => {
    const result = evaluateProtectedBranchAutomation(
      compatiblePolicy({ mergeQueueRequired: true }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "merge-authority")?.guidance,
    ).toMatch(/merge queue/i);
  });

  it("fail-closes when protection is available but not strict", () => {
    const result = evaluateProtectedBranchAutomation(
      compatiblePolicy({
        requiredStatusChecks: { strict: false, contexts: ["ci"] },
        staleBaseProtectionGuaranteed: false,
        branchProtectionObservation: "configured-non-strict",
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "stale-base-protection")?.ok,
    ).toBe(false);
    expect(
      result.checks.find((check) => check.id === "stale-base-protection")
        ?.guidance,
    ).toMatch(/protection is available but incomplete|up to date/i);
  });

  it("allows degraded automation when protection APIs are plan-limited", () => {
    const policy = compatiblePolicy({
      staleBaseProtectionGuaranteed: false,
      branchProtectionObservation: "plan-limited",
    });
    delete (policy as { requiredStatusChecks?: unknown }).requiredStatusChecks;
    const result = evaluateProtectedBranchAutomation(policy);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(
      result.checks.find((check) => check.id === "stale-base-protection")?.ok,
    ).toBe(true);
    expect(
      result.checks.find((check) => check.id === "branch-protection-unavailable")
        ?.guidance,
    ).toMatch(/403|plan|Pro-or-public/i);
    expect(
      result.checks.find((check) => check.id === "merge-authority")?.ok,
    ).toBe(true);
  });

  it("allows degraded automation when no protection rules are configured", () => {
    const policy = compatiblePolicy({
      staleBaseProtectionGuaranteed: false,
      branchProtectionObservation: "absent",
    });
    delete (policy as { requiredStatusChecks?: unknown }).requiredStatusChecks;
    const result = evaluateProtectedBranchAutomation(policy);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(
      result.checks.find((check) => check.id === "stale-base-protection")
        ?.guidance,
    ).toMatch(/degraded automatic delivery/i);
  });

  it("still fail-closes plan-limited repos when the actor cannot merge", () => {
    const policy = compatiblePolicy({
      staleBaseProtectionGuaranteed: false,
      branchProtectionObservation: "plan-limited",
      actorCanMergeWithoutApproval: false,
    });
    delete (policy as { requiredStatusChecks?: unknown }).requiredStatusChecks;
    const result = evaluateProtectedBranchAutomation(policy);
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "merge-authority")?.ok,
    ).toBe(false);
  });

  it("fail-closes when the actor cannot merge without human interaction", () => {
    const result = evaluateProtectedBranchAutomation(
      compatiblePolicy({ actorCanMergeWithoutApproval: false }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "merge-authority")?.guidance,
    ).toMatch(/human interaction|merge permission/i);
  });
});

describe("selectConfiguredMergeMethod", () => {
  it("uses the preferred method when allowed", () => {
    expect(
      selectConfiguredMergeMethod(
        compatiblePolicy({ preferredMergeMethod: "rebase", allowedMergeMethods: ["rebase", "merge"] }),
      ),
    ).toBe("rebase");
  });

  it("never invents a method that is not allowed", () => {
    expect(
      selectConfiguredMergeMethod(
        compatiblePolicy({
          preferredMergeMethod: "squash",
          allowedMergeMethods: ["merge"],
        }),
      ),
    ).toBe("merge");
  });
});

describe("evaluateMergeFreshness", () => {
  const baseInput = {
    heldLease: heldLease(),
    expectedGeneration: 3,
    expectedHolderId: "home-1",
    validatedTargetSha: TARGET,
    currentTargetSha: TARGET,
    expectedHeadSha: HEAD,
    currentHeadSha: HEAD,
    requiredChecks: { headSha: HEAD, status: "success" as const },
  };

  it("allows merge only with current lease, matching SHAs, and green checks", () => {
    expect(evaluateMergeFreshness(baseInput)).toEqual({ ok: true });
  });

  it("rejects a stale fencing token and marks the workflow retryable", () => {
    const result = evaluateMergeFreshness({
      ...baseInput,
      heldLease: heldLease({ generation: 2 }),
      expectedGeneration: 3,
    });
    expect(result).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.staleLease,
      recovery: "retryable",
    });
  });

  it("forces refresh when the Target branch advances after prior green checks", () => {
    const result = evaluateMergeFreshness({
      ...baseInput,
      currentTargetSha: OTHER,
    });
    expect(result).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.staleTargetSha,
      recovery: "requeue-refresh",
    });
  });

  it("rejects an unexpected PR head", () => {
    const result = evaluateMergeFreshness({
      ...baseInput,
      currentHeadSha: OTHER,
    });
    expect(result).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.unexpectedPrHead,
      recovery: "awaiting-pr-checks",
    });
  });

  it("rejects required-check observations for a different head", () => {
    const result = evaluateMergeFreshness({
      ...baseInput,
      requiredChecks: { headSha: OTHER, status: "success" },
    });
    expect(result).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksStaleHead,
      recovery: "awaiting-pr-checks",
    });
  });

  it("rejects non-green required checks for the expected head", () => {
    const pending = evaluateMergeFreshness({
      ...baseInput,
      requiredChecks: { headSha: HEAD, status: "pending" },
    });
    expect(pending).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksNotGreen,
      recovery: "awaiting-pr-checks",
    });

    const failed = evaluateMergeFreshness({
      ...baseInput,
      requiredChecks: { headSha: HEAD, status: "failure" },
    });
    expect(failed).toMatchObject({
      ok: false,
      code: MERGE_FRESHNESS_FAILURE_CODES.requiredChecksNotGreen,
      recovery: "retryable",
    });
  });

  it("allows merge without green CI when requireStatusChecks is false", () => {
    const pending = evaluateMergeFreshness({
      ...baseInput,
      requiredChecks: { headSha: HEAD, status: "pending" },
      requireStatusChecks: false,
    });
    expect(pending).toEqual({ ok: true });

    const failed = evaluateMergeFreshness({
      ...baseInput,
      requiredChecks: { headSha: HEAD, status: "failure" },
      requireStatusChecks: false,
    });
    expect(failed).toEqual({ ok: true });
  });
});

describe("policyRequiresStatusChecks", () => {
  it("is true only when contexts or strict required checks are configured", () => {
    expect(
      policyRequiresStatusChecks({
        requiredStatusChecks: { strict: true, contexts: ["ci"] },
      }),
    ).toBe(true);
    expect(
      policyRequiresStatusChecks({
        requiredStatusChecks: { strict: false, contexts: ["lint"] },
      }),
    ).toBe(true);
    expect(
      policyRequiresStatusChecks({
        requiredStatusChecks: { strict: false, contexts: [] },
      }),
    ).toBe(false);
    expect(policyRequiresStatusChecks({})).toBe(false);
  });
});

describe("mergeMethodCliFlag", () => {
  it("maps repository methods to gh flags without inventing extras", () => {
    expect(mergeMethodCliFlag("merge")).toBe("--merge");
    expect(mergeMethodCliFlag("squash")).toBe("--squash");
    expect(mergeMethodCliFlag("rebase")).toBe("--rebase");
  });
});
