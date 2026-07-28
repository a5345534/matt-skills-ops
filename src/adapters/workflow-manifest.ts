import {
  canonicalRepositoryIdentityKey,
  canonicalTargetIdentitiesEqual,
  isCanonicalRepositoryIdentity,
  isCanonicalTargetIdentity,
  targetBranchFromRef,
  targetRefFromBranch,
} from "../coordination.js";
import {
  WORKFLOW_MANIFEST_MARKER,
  WORKFLOW_MANIFEST_SCHEMA,
} from "../constants.js";
import type {
  ActiveWorkflow,
  CanonicalRepositoryIdentity,
  CanonicalTargetIdentity,
  CoordinationWorkflowManifest,
  LegacyWorkflowManifest,
  TargetBranchQueueCandidate,
  TransientWorkflowQueueRetry,
  WorkerProfile,
  WorkflowCoordinationFacts,
  WorkflowLeaseGenerationReferences,
  WorkflowManifest,
  WorkflowMergeMethod,
  WorkflowPrFreshness,
  WorkflowPrRef,
  WorkflowQueueRetry,
  WorkflowStage,
} from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWorkerProfile(value: unknown): value is WorkerProfile {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.thinkingLevel)
  );
}

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return (
    value === "spec-published" ||
    value === "tickets-published" ||
    value === "pr-opened" ||
    value === "merged" ||
    value === "completed"
  );
}

function isWorkflowPrRef(value: unknown): value is WorkflowPrRef {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.number) &&
    isNonEmptyString(value.headBranch) &&
    isNonEmptyString(value.baseBranch) &&
    (value.url === undefined || isNonEmptyString(value.url))
  );
}

function isTicketNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isPositiveInteger);
}

function isIntegratedTicketList(
  value: unknown,
): value is NonNullable<WorkflowManifest["integratedTickets"]> {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    return (
      isPositiveInteger(entry.number) &&
      isPositiveInteger(entry.attempt) &&
      isNonEmptyString(entry.branchName)
    );
  });
}

function isIsoInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
  );
}

function isWorkflowMergeMethod(value: unknown): value is WorkflowMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

function parseWorkflowPrFreshness(
  value: unknown,
): WorkflowPrFreshness | undefined {
  if (!isRecord(value)) return undefined;
  if (!isGitObjectId(value.headSha) || !isWorkflowMergeMethod(value.mergeMethod)) {
    return undefined;
  }
  if (
    hasOwn(value, "validatedTargetSha") &&
    !isGitObjectId(value.validatedTargetSha)
  ) {
    return undefined;
  }
  return {
    headSha: value.headSha,
    mergeMethod: value.mergeMethod,
    ...(hasOwn(value, "validatedTargetSha")
      ? { validatedTargetSha: value.validatedTargetSha as string }
      : {}),
  };
}

function parseWorkflowQueueRetry(
  value: unknown,
): WorkflowQueueRetry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.reason) ||
    !isPositiveInteger(value.attempt) ||
    !isIsoInstant(value.failedAt)
  ) {
    return undefined;
  }
  return {
    reason: value.reason,
    attempt: value.attempt,
    failedAt: value.failedAt,
  };
}

function parseTransientWorkflowQueueRetry(
  value: unknown,
): TransientWorkflowQueueRetry | undefined {
  const retry = parseWorkflowQueueRetry(value);
  if (!retry || !isRecord(value)) return undefined;
  if (
    !isPositiveInteger(value.maxAttempts) ||
    retry.attempt > value.maxAttempts ||
    !isIsoInstant(value.nextRetryAt)
  ) {
    return undefined;
  }
  return {
    ...retry,
    maxAttempts: value.maxAttempts,
    nextRetryAt: value.nextRetryAt,
  };
}

function parseTargetBranchQueueCandidate(
  value: unknown,
): TargetBranchQueueCandidate | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.state) {
    case "awaiting-pr-checks":
      return { state: "awaiting-pr-checks" };
    case "merge-ready":
      if (!isIsoInstant(value.mergeReadyAt)) return undefined;
      return { state: "merge-ready", mergeReadyAt: value.mergeReadyAt };
    case "refreshing":
      if (hasOwn(value, "mergeReadyAt") && !isIsoInstant(value.mergeReadyAt)) {
        return undefined;
      }
      return {
        state: "refreshing",
        ...(hasOwn(value, "mergeReadyAt")
          ? { mergeReadyAt: value.mergeReadyAt as string }
          : {}),
      };
    case "retryable": {
      const retry = parseWorkflowQueueRetry(value.retry);
      return retry ? { state: "retryable", retry } : undefined;
    }
    case "transient-retry": {
      const retry = parseTransientWorkflowQueueRetry(value.retry);
      return retry ? { state: "transient-retry", retry } : undefined;
    }
    case "merged":
      return { state: "merged" };
    default:
      return undefined;
  }
}

function parseLeaseGenerationReferences(
  value: unknown,
): WorkflowLeaseGenerationReferences | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    "workflowCoordinator",
    "targetBranch",
    "repositoryScheduler",
    "workerSlot",
  ] as const;
  let hasGeneration = false;
  const references: WorkflowLeaseGenerationReferences = {};
  for (const key of keys) {
    if (!hasOwn(value, key)) continue;
    if (!isPositiveInteger(value[key])) return undefined;
    references[key] = value[key];
    hasGeneration = true;
  }
  return hasGeneration ? references : undefined;
}

function parseWorkflowCoordinationFacts(
  value: unknown,
  targetBranch: string,
): WorkflowCoordinationFacts | undefined {
  if (!isRecord(value) || !isCanonicalTargetIdentity(value.target)) {
    return undefined;
  }
  const expectedTargetRef = targetRefFromBranch(targetBranch);
  if (!expectedTargetRef || value.target.targetRef !== expectedTargetRef) {
    return undefined;
  }

  const coordination: WorkflowCoordinationFacts = {
    target: {
      repository: {
        owner: value.target.repository.owner,
        name: value.target.repository.name,
      },
      targetRef: value.target.targetRef,
    },
  };

  if (hasOwn(value, "prFreshness")) {
    const prFreshness = parseWorkflowPrFreshness(value.prFreshness);
    if (!prFreshness) return undefined;
    coordination.prFreshness = prFreshness;
  }
  if (hasOwn(value, "queueCandidate")) {
    const queueCandidate = parseTargetBranchQueueCandidate(value.queueCandidate);
    if (!queueCandidate) return undefined;
    coordination.queueCandidate = queueCandidate;
  }
  if (hasOwn(value, "observedLeaseGenerations")) {
    const leaseGenerations = parseLeaseGenerationReferences(
      value.observedLeaseGenerations,
    );
    if (!leaseGenerations) return undefined;
    coordination.observedLeaseGenerations = leaseGenerations;
  }
  return coordination;
}

type ParsedWorkflowManifestFields = Omit<LegacyWorkflowManifest, "version">;

function parseOptionalManifestFields(
  value: Record<string, unknown>,
  manifest: ParsedWorkflowManifestFields,
): boolean {
  if (hasOwn(value, "tickets")) {
    if (!isTicketNumberList(value.tickets)) return false;
    manifest.tickets = [...value.tickets];
  }
  if (hasOwn(value, "integrationBranch")) {
    if (!isNonEmptyString(value.integrationBranch)) return false;
    manifest.integrationBranch = value.integrationBranch;
  }
  if (hasOwn(value, "integratedTickets")) {
    if (!isIntegratedTicketList(value.integratedTickets)) return false;
    manifest.integratedTickets = value.integratedTickets.map((ticket) => ({
      number: ticket.number,
      attempt: ticket.attempt,
      branchName: ticket.branchName,
    }));
  }
  if (hasOwn(value, "workflowPr")) {
    if (!isWorkflowPrRef(value.workflowPr)) return false;
    manifest.workflowPr = {
      number: value.workflowPr.number,
      headBranch: value.workflowPr.headBranch,
      baseBranch: value.workflowPr.baseBranch,
      ...(value.workflowPr.url !== undefined ? { url: value.workflowPr.url } : {}),
    };
  }
  if (hasOwn(value, "followUpOf")) {
    if (!isPositiveInteger(value.followUpOf)) return false;
    manifest.followUpOf = value.followUpOf;
  }
  return true;
}

/** Serialize a Workflow manifest into the managed GitHub comment body. */
export function formatWorkflowManifestComment(
  manifest: WorkflowManifest,
): string {
  return `${WORKFLOW_MANIFEST_MARKER}\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`;
}

/**
 * Parse a managed Workflow manifest from a GitHub comment body.
 * Version 1 manifests remain valid; version 2 manifests must carry validated
 * canonical Target identity and any supplied coordination facts.
 */
export function parseWorkflowManifestComment(
  body: string,
): WorkflowManifest | undefined {
  if (!body.includes(WORKFLOW_MANIFEST_MARKER)) return undefined;

  const markerIndex = body.indexOf(WORKFLOW_MANIFEST_MARKER);
  const markerBody = body.slice(markerIndex + WORKFLOW_MANIFEST_MARKER.length);
  const jsonMatch = /```json\s*([\s\S]*?)```/i.exec(markerBody);
  const raw = jsonMatch?.[1]?.trim();
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    if (
      parsed.schema !== WORKFLOW_MANIFEST_SCHEMA ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      !isPositiveInteger(parsed.workflowId) ||
      !isNonEmptyString(parsed.targetBranch) ||
      !isWorkflowStage(parsed.stage) ||
      !isWorkerProfile(parsed.workerProfile)
    ) {
      return undefined;
    }

    const fields: ParsedWorkflowManifestFields = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      workflowId: parsed.workflowId,
      targetBranch: parsed.targetBranch,
      stage: parsed.stage,
      workerProfile: {
        provider: parsed.workerProfile.provider,
        modelId: parsed.workerProfile.modelId,
        thinkingLevel: parsed.workerProfile.thinkingLevel,
      },
    };
    if (!parseOptionalManifestFields(parsed, fields)) return undefined;

    if (parsed.version === 1) {
      return { ...fields, version: 1 };
    }

    if (!hasOwn(parsed, "coordination")) return undefined;
    const coordination = parseWorkflowCoordinationFacts(
      parsed.coordination,
      fields.targetBranch,
    );
    if (!coordination) return undefined;

    if (
      fields.workflowPr &&
      fields.workflowPr.baseBranch !== fields.targetBranch
    ) {
      return undefined;
    }
    // Queue states and freshness are facts about an existing Workflow PR. Do not
    // accept partial coordination state that could be mistaken for merge-ready.
    if (coordination.prFreshness && !fields.workflowPr) return undefined;
    if (coordination.queueCandidate && !coordination.prFreshness) {
      return undefined;
    }

    const manifest: CoordinationWorkflowManifest = {
      ...fields,
      version: 2,
      coordination,
    };
    return manifest;
  } catch {
    return undefined;
  }
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
      return {
        state: "refreshing",
        ...(candidate.mergeReadyAt
          ? { mergeReadyAt: candidate.mergeReadyAt }
          : {}),
      };
    case "retryable":
      return { state: "retryable", retry: { ...candidate.retry } };
    case "transient-retry":
      return { state: "transient-retry", retry: { ...candidate.retry } };
    case "merged":
      return { state: "merged" };
  }
}

function copyCoordinationFacts(
  coordination: WorkflowCoordinationFacts,
): WorkflowCoordinationFacts {
  const copy: WorkflowCoordinationFacts = {
    target: {
      repository: { ...coordination.target.repository },
      targetRef: coordination.target.targetRef,
    },
  };
  if (coordination.prFreshness) {
    copy.prFreshness = { ...coordination.prFreshness };
  }
  if (coordination.queueCandidate) {
    copy.queueCandidate = copyQueueCandidate(coordination.queueCandidate);
  }
  if (coordination.observedLeaseGenerations) {
    copy.observedLeaseGenerations = {
      ...coordination.observedLeaseGenerations,
    };
  }
  return copy;
}

/** Does a manifest belong to this canonical Target identity? */
export function workflowManifestMatchesTarget(
  manifest: WorkflowManifest,
  target: CanonicalTargetIdentity,
): boolean {
  if (!isCanonicalTargetIdentity(target)) return false;
  if (manifest.version === 2) {
    return canonicalTargetIdentitiesEqual(manifest.coordination.target, target);
  }
  const targetBranch = targetBranchFromRef(target.targetRef);
  return targetBranch !== undefined && manifest.targetBranch === targetBranch;
}

/** Convert a parsed manifest into the Active-workflow projection used by callers. */
export function activeWorkflowFromManifest(
  manifest: WorkflowManifest,
  title?: string,
): ActiveWorkflow {
  const active: ActiveWorkflow = {
    workflowId: manifest.workflowId,
    targetBranch: manifest.targetBranch,
    stage: manifest.stage,
    workerProfile: { ...manifest.workerProfile },
  };
  if (manifest.tickets) active.tickets = [...manifest.tickets];
  if (manifest.integrationBranch) {
    active.integrationBranch = manifest.integrationBranch;
  }
  if (manifest.integratedTickets) {
    active.integratedTickets = manifest.integratedTickets.map((ticket) => ({
      ...ticket,
    }));
  }
  if (manifest.workflowPr) active.workflowPr = { ...manifest.workflowPr };
  if (manifest.version === 2) {
    active.coordination = copyCoordinationFacts(manifest.coordination);
  }
  if (manifest.followUpOf !== undefined) {
    active.followUpOf = manifest.followUpOf;
  }
  if (title?.trim()) active.title = title;
  return active;
}

/** One open GitHub issue plus all of its managed-comment candidates. */
export type WorkflowManifestIssue = {
  number: number;
  title?: string;
  state?: string;
  comments: readonly { body?: unknown }[];
};

function latestManifestFromComments(
  comments: readonly { body?: unknown }[],
): WorkflowManifest | undefined {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const body = comments[index]?.body;
    if (typeof body !== "string" || !body.includes(WORKFLOW_MANIFEST_MARKER)) {
      continue;
    }
    // The latest managed comment is authoritative. A malformed replacement is
    // ignored rather than silently reviving stale coordination facts.
    return parseWorkflowManifestComment(body);
  }
  return undefined;
}

/**
 * Reconstruct every Active workflow for one canonical Target from a complete,
 * paginated issue/comment snapshot. Results are deterministic by Workflow ID.
 */
export function activeWorkflowsFromIssues(
  target: CanonicalTargetIdentity,
  issues: readonly WorkflowManifestIssue[],
): ActiveWorkflow[] {
  if (!isCanonicalTargetIdentity(target)) return [];
  const active = new Map<number, ActiveWorkflow>();
  for (const issue of issues) {
    if (!isPositiveInteger(issue.number)) continue;
    if (issue.state && issue.state.toUpperCase() !== "OPEN") continue;
    const manifest = latestManifestFromComments(issue.comments);
    if (
      !manifest ||
      manifest.workflowId !== issue.number ||
      manifest.stage === "completed" ||
      !workflowManifestMatchesTarget(manifest, target)
    ) {
      continue;
    }
    active.set(
      manifest.workflowId,
      activeWorkflowFromManifest(manifest, issue.title),
    );
  }
  return [...active.values()].sort(
    (left, right) => left.workflowId - right.workflowId,
  );
}

/**
 * Reconstruct every coordination-aware Active workflow for a repository across
 * Target branches. Version-one manifests intentionally remain out of this
 * result: they use legacy local concurrency and cannot participate in remote
 * repository worker-slot scheduling.
 */
export function coordinatedActiveWorkflowsFromIssues(
  repository: CanonicalRepositoryIdentity,
  issues: readonly WorkflowManifestIssue[],
): ActiveWorkflow[] {
  if (!isCanonicalRepositoryIdentity(repository)) return [];
  const wanted = canonicalRepositoryIdentityKey(repository);
  const active = new Map<number, ActiveWorkflow>();
  for (const issue of issues) {
    if (!isPositiveInteger(issue.number)) continue;
    if (issue.state && issue.state.toUpperCase() !== "OPEN") continue;
    const manifest = latestManifestFromComments(issue.comments);
    if (
      !manifest ||
      manifest.version !== 2 ||
      manifest.workflowId !== issue.number ||
      manifest.stage === "completed" ||
      canonicalRepositoryIdentityKey(manifest.coordination.target.repository) !==
        wanted
    ) {
      continue;
    }
    active.set(
      manifest.workflowId,
      activeWorkflowFromManifest(manifest, issue.title),
    );
  }
  return [...active.values()].sort(
    (left, right) => left.workflowId - right.workflowId,
  );
}
