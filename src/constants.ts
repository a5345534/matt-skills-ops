/** Default Target branch when no Workflow-root override is configured. */
export const DEFAULT_TARGET_BRANCH = "main";

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
 * Format: matt-auto/<Workflow ID>
 */
export function integrationBranchName(workflowId: number): string {
  return `matt-auto/${workflowId}`;
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
