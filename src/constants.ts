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
