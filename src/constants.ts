/** Default Target branch when no Workflow-root override is configured. */
export const DEFAULT_TARGET_BRANCH = "main";

/**
 * Default Worker concurrency when neither global nor Workflow-root override is set.
 * Domain: Worker concurrency defaults to two with no Matt Auto hard upper limit.
 */
export const DEFAULT_WORKER_CONCURRENCY = 2;

/**
 * Concurrency warning threshold for the configure UI.
 * Setting N above this shows a one-time confirmation; run-time filling does not re-prompt.
 * Fixed for this slice (initially four).
 */
export const WORKER_CONCURRENCY_WARNING_THRESHOLD = 4;

/**
 * Matt skills required for Matt Auto V1.
 * Discovered at runtime; never bundled or pinned.
 */
export const REQUIRED_MATT_SKILLS = [
  "to-spec",
  "to-tickets",
  "implement",
  "resolving-merge-conflicts",
] as const;

/**
 * Explanation when a Workflow root has no supported GitHub tracker.
 * Non-GitHub roots are unavailable rather than partially automated.
 */
export const UNSUPPORTED_TRACKER_REASON =
  "This Workflow root does not use a supported tracker. Matt Auto V1 requires a GitHub remote accessible through the gh CLI. Non-GitHub roots are unavailable rather than partially automated.";

/**
 * Explanation when the start path is not inside any Git repository.
 */
export const NO_GIT_REPOSITORY_REASON =
  "Not inside a Git repository. Matt Auto selects Workflow roots from independently managed Git repositories. Open a path inside a Git repository, or clone one first. Matt Auto V1 does not run git init or create repositories.";

/** Next action: Create-spec Planning stage in Workflow home. */
export const CREATE_SPEC_ACTION = {
  id: "create-spec",
  label: "Create spec",
  description:
    "Run the Create-spec Planning stage in Workflow home using the installed to-spec skill.",
} as const;

/** Next action: Create-tickets Planning stage (after a published spec). */
export const CREATE_TICKETS_ACTION = {
  id: "create-tickets",
  label: "Create tickets",
  description:
    "Break the published spec into tickets as a Planning stage in Workflow home.",
} as const;

/** Stage confirmation choices after a reviewable Planning-stage artifact. */
export const STAGE_CONFIRMATION_OPTIONS = [
  "publish",
  "revise",
  "cancel",
] as const;

/** HTML comment marker for the managed Workflow manifest GitHub comment. */
export const WORKFLOW_MANIFEST_MARKER = "<!-- matt-auto:workflow-manifest -->";

/** Schema id embedded in the Workflow manifest JSON body. */
export const WORKFLOW_MANIFEST_SCHEMA = "matt-auto/workflow-manifest" as const;

/** Triage label applied to published specs. */
export const SPEC_ISSUE_LABEL = "ready-for-agent";

/** Triage label applied to published tickets (agent-grabbable by construction). */
export const TICKET_ISSUE_LABEL = "ready-for-agent";

/** Next action: ticket-progress summary after Create-tickets publish. */
export const TICKET_PROGRESS_ACTION = {
  id: "ticket-progress",
  label: "Ticket progress",
  description:
    "Show ready frontier and ticket progress for the Active workflow.",
} as const;

/** Prefix for Next actions that launch one ready ticket as an Implementation worker. */
export const IMPLEMENT_TICKET_ACTION_PREFIX = "implement-ticket:" as const;

/** Prefix for Next actions that resolve a pending Implementation disposition. */
export const DISPOSITION_ACTION_PREFIX = "disposition:" as const;

/** Implementation disposition choices after a successful worker Stage result. */
export const IMPLEMENTATION_DISPOSITION_OPTIONS = [
  "close",
  "leave-open",
  "investigate",
] as const;

/**
 * Branch name for one Implementation workspace attempt.
 * Format: matt-auto/<Workflow ID>/ticket-<n>/r<attempt>
 */
export function implementationBranchName(
  workflowId: number,
  ticketNumber: number,
  attempt: number,
): string {
  return `matt-auto/${workflowId}/ticket-${ticketNumber}/r${attempt}`;
}

/**
 * Branch name for the workflow Integration branch.
 * Format: matt-auto/<Workflow ID>/integration
 *
 * NOTE: Must NOT be `matt-auto/<id>` alone — Git forbids a branch ref that is a
 * prefix of another (e.g. matt-auto/255 vs matt-auto/255/ticket-256/r1).
 */
export function integrationBranchName(workflowId: number): string {
  return `matt-auto/${workflowId}/integration`;
}

/** Prefix for Next actions that retry a failed Integration unit. */
export const INTEGRATE_TICKET_ACTION_PREFIX = "integrate-ticket:" as const;

/** Build the Next action id for integrating (or retrying) one ticket. */
export function integrateTicketActionId(ticketNumber: number): string {
  return `${INTEGRATE_TICKET_ACTION_PREFIX}${ticketNumber}`;
}

/** Parse an integrate-ticket Next action id. */
export function parseIntegrateTicketActionId(
  actionId: string,
): number | undefined {
  if (!actionId.startsWith(INTEGRATE_TICKET_ACTION_PREFIX)) {
    return undefined;
  }
  const raw = actionId.slice(INTEGRATE_TICKET_ACTION_PREFIX.length);
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return number;
}

/** Build the Next action id for implementing one ready ticket. */
export function implementTicketActionId(ticketNumber: number): string {
  return `${IMPLEMENT_TICKET_ACTION_PREFIX}${ticketNumber}`;
}

/** Parse an implement-ticket Next action id. */
export function parseImplementTicketActionId(
  actionId: string,
): number | undefined {
  if (!actionId.startsWith(IMPLEMENT_TICKET_ACTION_PREFIX)) {
    return undefined;
  }
  const raw = actionId.slice(IMPLEMENT_TICKET_ACTION_PREFIX.length);
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return number;
}

/** Build the Next action id for a pending Implementation disposition. */
export function dispositionActionId(ticketNumber: number): string {
  return `${DISPOSITION_ACTION_PREFIX}${ticketNumber}`;
}

/** Parse a disposition Next action id. */
export function parseDispositionActionId(
  actionId: string,
): number | undefined {
  if (!actionId.startsWith(DISPOSITION_ACTION_PREFIX)) {
    return undefined;
  }
  const raw = actionId.slice(DISPOSITION_ACTION_PREFIX.length);
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return number;
}

/** Prefix for Next actions that run an on-demand CI gate check. */
export const CHECK_CI_ACTION_PREFIX = "check-ci:" as const;

/** Prefix for CI red recovery Next actions. */
export const CI_RECOVERY_ACTION_PREFIX = "ci-recovery:" as const;

/** CI red recovery choices after a failed on-demand CI gate check. */
export const CI_RECOVERY_OPTIONS = [
  "inspect",
  "retry",
  "leave-open",
] as const;

export function checkCiActionId(ticketNumber: number): string {
  return `${CHECK_CI_ACTION_PREFIX}${ticketNumber}`;
}

export function parseCheckCiActionId(actionId: string): number | undefined {
  if (!actionId.startsWith(CHECK_CI_ACTION_PREFIX)) return undefined;
  const number = Number(actionId.slice(CHECK_CI_ACTION_PREFIX.length));
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return number;
}

export function ciRecoveryActionId(
  ticketNumber: number,
  decision: (typeof CI_RECOVERY_OPTIONS)[number],
): string {
  return `${CI_RECOVERY_ACTION_PREFIX}${decision}:${ticketNumber}`;
}

export function parseCiRecoveryActionId(
  actionId: string,
):
  | { ticketNumber: number; decision: (typeof CI_RECOVERY_OPTIONS)[number] }
  | undefined {
  if (!actionId.startsWith(CI_RECOVERY_ACTION_PREFIX)) return undefined;
  const rest = actionId.slice(CI_RECOVERY_ACTION_PREFIX.length);
  const match = /^(inspect|retry|leave-open):(\d+)$/.exec(rest);
  if (!match) return undefined;
  const decision = match[1] as (typeof CI_RECOVERY_OPTIONS)[number];
  const ticketNumber = Number(match[2]);
  if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) return undefined;
  return { ticketNumber, decision };
}

/** Next action: open the single Workflow PR (Integration → Target). */
export const OPEN_WORKFLOW_PR_ACTION = {
  id: "open-workflow-pr",
  label: "Open Workflow PR",
  description:
    "Open one Workflow PR from the Integration branch to the Target branch after all tickets are integrated and CI-complete.",
} as const;

/** Next action: merge the Workflow PR through Matt Auto. */
export const MERGE_WORKFLOW_PR_ACTION = {
  id: "merge-workflow-pr",
  label: "Merge Workflow PR",
  description:
    "Merge the Workflow PR as a Next action rather than requiring a manual GitHub operation.",
} as const;

/** Next action: paired local + remote Workflow cleanup after merge. */
export const CLEANUP_WORKFLOW_ACTION = {
  id: "cleanup-workflow",
  label: "Cleanup workflow",
  description:
    "Remove local workspaces/transcripts and matching remote matt-auto branches, then close the parent Workflow spec issue. Notifies you to git pull and /reload; does not pull or reload automatically.",
} as const;

/** Next action: start a Follow-up workflow after the original Workflow PR merges. */
export const START_FOLLOW_UP_ACTION = {
  id: "start-follow-up",
  label: "Start Follow-up workflow",
  description:
    "Create a Follow-up workflow with a new spec issue that references the completed workflow rather than mutating it.",
} as const;

/** Prefix for Next actions that start a pre-merge Rework attempt for a closed ticket. */
export const REWORK_TICKET_ACTION_PREFIX = "rework-ticket:" as const;

/** Build the Next action id for a pre-merge Rework attempt. */
export function reworkTicketActionId(ticketNumber: number): string {
  return `${REWORK_TICKET_ACTION_PREFIX}${ticketNumber}`;
}

/** Parse a rework-ticket Next action id. */
export function parseReworkTicketActionId(
  actionId: string,
): number | undefined {
  if (!actionId.startsWith(REWORK_TICKET_ACTION_PREFIX)) {
    return undefined;
  }
  const raw = actionId.slice(REWORK_TICKET_ACTION_PREFIX.length);
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    return undefined;
  }
  return number;
}
