import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type {
  EnvironmentPort,
  PreferencesPort,
  SkillsPort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type { WorkerProfile } from "../src/types.js";
import { DEFAULT_TARGET_BRANCH, REQUIRED_MATT_SKILLS } from "../src/constants.js";

function createEnvironment(
  overrides: Partial<EnvironmentPort> = {},
): EnvironmentPort {
  return {
    hasGitHubRemote: async () => true,
    isGhAuthenticated: async () => true,
    targetBranchExists: async () => true,
    ...overrides,
  };
}

function createSkills(
  names: readonly string[] = [...REQUIRED_MATT_SKILLS],
): SkillsPort {
  return {
    installedSkillNames: async () => names,
  };
}

function createPreferences(
  overrides: {
    targetBranch?: string;
    workerProfile?: WorkerProfile;
  } = {},
): PreferencesPort {
  return {
    getConfiguredTargetBranch: async () => overrides.targetBranch,
    getWorkerProfile: async () => overrides.workerProfile,
  };
}

const defaultWorkerProfile: WorkerProfile = {
  modelId: "claude-sonnet-4",
  thinkingLevel: "medium",
};

function createPorts(
  overrides: Partial<{
    environment: EnvironmentPort;
    skills: SkillsPort;
    preferences: PreferencesPort;
  }> = {},
): WorkflowCoordinatorPorts {
  return {
    environment: overrides.environment ?? createEnvironment(),
    skills: overrides.skills ?? createSkills(),
    preferences:
      overrides.preferences ??
      createPreferences({ workerProfile: defaultWorkerProfile }),
  };
}

describe("Workflow coordinator preflight", () => {
  it("passes when GitHub remote, gh auth, Target branch, Matt skills, and Worker profile are present", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    const result = await coordinator.preflight();

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe(DEFAULT_TARGET_BRANCH);
    expect(result.checks.map((c) => c.id)).toEqual([
      "github-remote",
      "gh-auth",
      "target-branch",
      "matt-skills",
      "worker-profile",
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("uses the configured Target branch override when present", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        preferences: createPreferences({
          targetBranch: "develop",
          workerProfile: defaultWorkerProfile,
        }),
      }),
    );

    const result = await coordinator.preflight();

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("develop");
  });

  it("fails closed when there is no GitHub remote and offers corrective guidance", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        environment: createEnvironment({
          hasGitHubRemote: async () => false,
        }),
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "github-remote");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/GitHub remote/i);
    expect(check?.guidance).not.toMatch(/git init|create repository|push/i);
  });

  it("fails closed when gh is not authenticated and guides login", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        environment: createEnvironment({
          isGhAuthenticated: async () => false,
        }),
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "gh-auth");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/gh auth login/i);
  });

  it("fails closed when the Target branch does not exist", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        environment: createEnvironment({
          targetBranchExists: async (branch) => branch !== "main",
        }),
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "target-branch");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/main/);
    expect(check?.guidance).toMatch(/does not create branches/i);
    expect(check?.guidance).not.toMatch(/git init|create repository for you|I'll push|will push/i);
  });

  it("fails closed when required Matt skills are missing and lists them", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        skills: createSkills(["to-spec", "implement"]),
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "matt-skills");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/to-tickets/);
    expect(check?.guidance).toMatch(/resolving-merge-conflicts/);
  });

  it("fails closed when Worker profile is missing", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        preferences: createPreferences({}),
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "worker-profile");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/Worker profile/i);
  });
});

describe("Workflow coordinator Next actions", () => {
  it("returns no Next actions when preflight fails", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        environment: createEnvironment({
          hasGitHubRemote: async () => false,
        }),
      }),
    );

    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });

  it("returns no planning or implementation Next actions yet when preflight passes", async () => {
    // Ticket #2: package shell and preflight only — stages land in later tickets.
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });
});
