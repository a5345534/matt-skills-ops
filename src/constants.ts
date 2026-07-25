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
