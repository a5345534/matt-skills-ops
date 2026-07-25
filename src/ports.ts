import type { AvailableModel, WorkerProfile } from "./types.js";

/**
 * Environment facts for Workflow preflight on one Workflow root.
 * System boundary: git remotes, gh auth, branch existence.
 */
export type EnvironmentPort = {
  /** Whether the Workflow root has a GitHub remote. */
  hasGitHubRemote(): Promise<boolean>;
  /** Whether `gh` is authenticated for GitHub. */
  isGhAuthenticated(): Promise<boolean>;
  /** Whether the given branch exists locally or on a remote. */
  targetBranchExists(branch: string): Promise<boolean>;
};

/**
 * Installed Matt skill discovery.
 * System boundary: skill filesystem / Pi skill catalog.
 */
export type SkillsPort = {
  /** Skill names currently installed and discoverable. */
  installedSkillNames(): Promise<readonly string[]>;
};

/**
 * Local preferences and rebuildable cache.
 * System boundary: `.pi/matt-auto/` and global Matt Auto prefs.
 *
 * Worker profile layers are stored separately; the Workflow coordinator
 * resolves precedence (snapshot → root → global).
 */
export type PreferencesPort = {
  /**
   * Configured Target branch override for the Workflow root.
   * `undefined` means use the Matt Auto default (`main`).
   */
  getConfiguredTargetBranch(): Promise<string | undefined>;
  /** Global default Worker profile, if set. */
  getGlobalWorkerProfile(): Promise<WorkerProfile | undefined>;
  /** Workflow-root Worker profile override, if set. */
  getRootWorkerProfile(): Promise<WorkerProfile | undefined>;
  /**
   * Worker profile snapshot captured by an Active workflow, if any.
   * Later tickets populate this from the Workflow manifest.
   */
  getWorkflowSnapshotWorkerProfile(): Promise<WorkerProfile | undefined>;
  /** Persist the global default Worker profile. */
  setGlobalWorkerProfile(profile: WorkerProfile): Promise<void>;
  /** Persist the Workflow-root Worker profile override. */
  setRootWorkerProfile(profile: WorkerProfile): Promise<void>;
  /** Clear the Workflow-root Worker profile override. */
  clearRootWorkerProfile(): Promise<void>;
};

/**
 * Pi authenticated available-model catalog.
 * System boundary: Pi ModelRegistry / model runtime.
 * Never mutates the Workflow home currently selected model.
 */
export type ModelsPort = {
  /** Models currently available under authenticated providers. */
  listAvailableModels(): Promise<readonly AvailableModel[]>;
};

/**
 * A nested Git repository found under a parent Workflow root.
 * System boundary: filesystem / git topology (facts only).
 */
export type NestedGitRepository = {
  path: string;
  /** True when this nested repo is a Git submodule of the parent. */
  isSubmodule: boolean;
};

/**
 * Git repository topology for Root selection.
 * System boundary: git roots and nested repository layout.
 * Product rules (submodule exclusion, availability) live in the coordinator.
 */
export type GitTopologyPort = {
  /**
   * Nearest enclosing Git repository for startPath.
   * `undefined` when startPath is not inside a Git repository.
   */
  nearestGitRoot(startPath: string): Promise<string | undefined>;
  /**
   * Nested Git repositories under parentRoot (not including parentRoot itself).
   * Includes both independent clones and submodules; the coordinator filters.
   */
  nestedGitRepositories(
    parentRoot: string,
  ): Promise<readonly NestedGitRepository[]>;
};

/** Root-scoped ports rebound when the selected Workflow root changes. */
export type RootScopedPorts = {
  environment: EnvironmentPort;
  skills: SkillsPort;
  preferences: PreferencesPort;
};

/** Ports injected into the Workflow coordinator. */
export type WorkflowCoordinatorPorts = {
  /** Working directory used as the Root selection starting point. */
  startPath: string;
  topology: GitTopologyPort;
  /** Pi available-model catalog (session-scoped, not root-scoped). */
  models: ModelsPort;
  /** Create environment / skills / preferences bound to a Workflow root path. */
  forRoot(rootPath: string): RootScopedPorts;
};
