import path from "node:path";
import {
  DEFAULT_TARGET_BRANCH,
  NO_GIT_REPOSITORY_REASON,
  REQUIRED_MATT_SKILLS,
  UNSUPPORTED_TRACKER_REASON,
} from "./constants.js";
import type {
  RootScopedPorts,
  WorkflowCoordinatorPorts,
} from "./ports.js";
import type {
  NextAction,
  PreflightCheck,
  PreflightResult,
  WorkflowCoordinator,
  WorkflowRoot,
  WorkflowRootKind,
} from "./types.js";

/**
 * Create the Workflow coordinator — the sole product seam for Matt Auto.
 *
 * Product rules (root selection, preflight, Next actions, later stages) live here.
 * Adapters are injected as ports and are not part of this interface.
 */
export function createWorkflowCoordinator(
  ports: WorkflowCoordinatorPorts,
): WorkflowCoordinator {
  let selectedPath: string | undefined;
  let scoped: RootScopedPorts | undefined;

  function bindRoot(rootPath: string): void {
    selectedPath = rootPath;
    scoped = ports.forRoot(rootPath);
  }

  async function classifyRoot(
    rootPath: string,
    kind: WorkflowRootKind,
  ): Promise<WorkflowRoot> {
    const { environment } = ports.forRoot(rootPath);
    const hasGitHubRemote = await environment.hasGitHubRemote();
    if (!hasGitHubRemote) {
      return {
        path: rootPath,
        kind,
        status: "unavailable",
        unavailableReason: UNSUPPORTED_TRACKER_REASON,
      };
    }
    return {
      path: rootPath,
      kind,
      status: "available",
    };
  }

  async function discoverRoots(): Promise<WorkflowRoot[]> {
    const nearest = await ports.topology.nearestGitRoot(ports.startPath);

    if (!nearest) {
      const fallback = path.resolve(ports.startPath);
      return [
        {
          path: fallback,
          kind: "nearest",
          status: "unavailable",
          unavailableReason: NO_GIT_REPOSITORY_REASON,
        },
      ];
    }

    const resolvedNearest = path.resolve(nearest);
    const nested = await ports.topology.nestedGitRepositories(resolvedNearest);
    const independent = nested
      .filter((repo) => !repo.isSubmodule)
      .map((repo) => path.resolve(repo.path))
      .sort((a, b) => a.localeCompare(b));

    const candidates: Array<{ path: string; kind: WorkflowRootKind }> = [
      { path: resolvedNearest, kind: "nearest" },
      ...independent.map((nestedPath) => ({
        path: nestedPath,
        kind: "nested-independent" as const,
      })),
    ];

    return Promise.all(
      candidates.map(({ path: rootPath, kind }) =>
        classifyRoot(rootPath, kind),
      ),
    );
  }

  async function ensureSelected(): Promise<WorkflowRoot> {
    const roots = await discoverRoots();
    const defaultRoot = roots[0];
    if (!defaultRoot) {
      // discoverRoots always returns at least the nearest/fallback entry.
      throw new Error("Root selection produced no Workflow roots.");
    }

    if (!selectedPath) {
      bindRoot(defaultRoot.path);
      return defaultRoot;
    }

    const current = roots.find((root) => root.path === selectedPath);
    if (!current) {
      bindRoot(defaultRoot.path);
      return defaultRoot;
    }

    if (!scoped) {
      bindRoot(current.path);
    }
    return current;
  }

  async function preflight(): Promise<PreflightResult> {
    await ensureSelected();
    if (!scoped) {
      throw new Error("Workflow root ports are not bound.");
    }

    const configuredTarget =
      await scoped.preferences.getConfiguredTargetBranch();
    const targetBranch = configuredTarget ?? DEFAULT_TARGET_BRANCH;

    const [
      hasGitHubRemote,
      isGhAuthenticated,
      targetBranchExists,
      installedSkills,
      workerProfile,
    ] = await Promise.all([
      scoped.environment.hasGitHubRemote(),
      scoped.environment.isGhAuthenticated(),
      scoped.environment.targetBranchExists(targetBranch),
      scoped.skills.installedSkillNames(),
      scoped.preferences.getWorkerProfile(),
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

  async function currentRoot(): Promise<WorkflowRoot> {
    return ensureSelected();
  }

  async function listRoots(): Promise<WorkflowRoot[]> {
    await ensureSelected();
    return discoverRoots();
  }

  async function selectRoot(rootPath: string): Promise<WorkflowRoot> {
    const resolved = path.resolve(rootPath);
    const roots = await discoverRoots();
    const match = roots.find((root) => root.path === resolved);
    if (!match) {
      throw new Error(
        `Path "${rootPath}" is not a discovered Workflow root. Choose a root from listRoots().`,
      );
    }
    bindRoot(match.path);
    return match;
  }

  return {
    preflight,
    nextActions,
    currentRoot,
    listRoots,
    selectRoot,
  };
}
