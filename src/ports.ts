import type { WorkerProfile } from "./types.js";

/**
 * Environment facts for Workflow preflight.
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
 */
export type PreferencesPort = {
  /**
   * Configured Target branch override for the Workflow root.
   * `undefined` means use the Matt Auto default (`main`).
   */
  getConfiguredTargetBranch(): Promise<string | undefined>;
  /**
   * Effective Worker profile after global / root / snapshot precedence.
   * `undefined` means no profile is configured yet.
   */
  getWorkerProfile(): Promise<WorkerProfile | undefined>;
};

/** Ports injected into the Workflow coordinator. */
export type WorkflowCoordinatorPorts = {
  environment: EnvironmentPort;
  skills: SkillsPort;
  preferences: PreferencesPort;
};
