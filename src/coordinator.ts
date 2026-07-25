import {
  DEFAULT_TARGET_BRANCH,
  REQUIRED_MATT_SKILLS,
} from "./constants.js";
import type { WorkflowCoordinatorPorts } from "./ports.js";
import type {
  NextAction,
  PreflightCheck,
  PreflightResult,
  WorkflowCoordinator,
} from "./types.js";

/**
 * Create the Workflow coordinator — the sole product seam for Matt Auto.
 *
 * Product rules (preflight, Next actions, later stages) live here.
 * Adapters are injected as ports and are not part of this interface.
 */
export function createWorkflowCoordinator(
  ports: WorkflowCoordinatorPorts,
): WorkflowCoordinator {
  async function preflight(): Promise<PreflightResult> {
    const configuredTarget =
      await ports.preferences.getConfiguredTargetBranch();
    const targetBranch = configuredTarget ?? DEFAULT_TARGET_BRANCH;

    const [
      hasGitHubRemote,
      isGhAuthenticated,
      targetBranchExists,
      installedSkills,
      workerProfile,
    ] = await Promise.all([
      ports.environment.hasGitHubRemote(),
      ports.environment.isGhAuthenticated(),
      ports.environment.targetBranchExists(targetBranch),
      ports.skills.installedSkillNames(),
      ports.preferences.getWorkerProfile(),
    ]);

    const installed = new Set(installedSkills);
    const missingSkills = REQUIRED_MATT_SKILLS.filter(
      (name) => !installed.has(name),
    );

    const checks: PreflightCheck[] = [
      {
        id: "github-remote",
        ok: hasGitHubRemote,
        guidance: hasGitHubRemote
          ? "GitHub remote is configured."
          : "No GitHub remote found on this Workflow root. Add a GitHub remote (for example `origin`) pointing at a GitHub repository. Matt Auto V1 does not create repositories or remotes.",
      },
      {
        id: "gh-auth",
        ok: isGhAuthenticated,
        guidance: isGhAuthenticated
          ? "gh is authenticated."
          : "GitHub CLI is not authenticated. Run `gh auth login` and retry Workflow preflight. Matt Auto V1 does not perform login for you.",
      },
      {
        id: "target-branch",
        ok: targetBranchExists,
        guidance: targetBranchExists
          ? `Target branch "${targetBranch}" is available.`
          : `Target branch "${targetBranch}" was not found locally or on a remote. Create or fetch that branch yourself, or configure a different Target branch for this Workflow root. Matt Auto V1 does not create branches or push.`,
      },
      {
        id: "matt-skills",
        ok: missingSkills.length === 0,
        guidance:
          missingSkills.length === 0
            ? "Required Matt skills are installed."
            : `Missing required Matt skills: ${missingSkills.join(", ")}. Install them into a Pi skill location and retry. Matt Auto adapts installed skills and does not bundle them.`,
      },
      {
        id: "worker-profile",
        ok: workerProfile !== undefined,
        guidance:
          workerProfile !== undefined
            ? `Worker profile is set (${workerProfile.modelId}, thinking ${workerProfile.thinkingLevel}).`
            : "No Worker profile is configured. Set a global or Workflow-root Worker profile (model + thinking level) before starting Implementation workers.",
      },
    ];

    return {
      ok: checks.every((check) => check.ok),
      targetBranch,
      checks,
    };
  }

  async function nextActions(): Promise<NextAction[]> {
    const result = await preflight();
    if (!result.ok) {
      return [];
    }

    // Planning and Implementation stages are added by later tickets.
    // Preflight-complete environments currently have no available Next actions.
    return [];
  }

  return { preflight, nextActions };
}
