import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillsPort } from "../src/adapters/skills.js";
import { createWorkspacePort } from "../src/adapters/workspace.js";
import { createFakeCoordinationPort } from "../src/adapters/coordination.js";
import { createTargetBranchQueueOrchestrator } from "../src/target-branch-queue.js";
import {
  TARGET_REFRESH_FAILURE_REASONS,
  classifyTargetRefreshResult,
  mergeTargetIntoIntegration,
  recordTargetRefreshFailure,
  refreshedWorkflowPrFreshness,
  releaseTargetRefreshForPrChecks,
  targetRefreshConflictSkillInput,
  ticketIntegrationConflictSkillInput,
} from "../src/target-refresh.js";
import type {
  ActiveWorkflow,
  CanonicalTargetIdentity,
  WorkflowCoordinatorLease,
  WorkflowManifest,
} from "../src/types.js";

const execFileAsync = promisify(execFile);

const target: CanonicalTargetIdentity = {
  repository: { owner: "acme", name: "widgets" },
  targetRef: "refs/heads/main",
};

const sha = (ch: string) => ch.repeat(40);

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
    },
  });
}

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort cleanup; leave directories if removal races with open fds.
  for (const dir of tempDirs.splice(0)) {
    try {
      await execFileAsync("rm", ["-rf", dir]);
    } catch {
      // ignore
    }
  }
});

async function createRefreshFixture(): Promise<{
  work: string;
  bare: string;
  mainSha: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "matt-refresh-"));
  tempDirs.push(root);
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  await mkdir(bare, { recursive: true });
  await git(bare, ["init", "--bare", "-b", "main"]);
  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await writeFile(path.join(work, "base.txt"), "base\n");
  await git(work, ["add", "base.txt"]);
  await git(work, ["commit", "-m", "base"]);
  await git(work, ["remote", "add", "origin", bare]);
  await git(work, ["push", "-u", "origin", "main"]);
  const mainSha = (await git(work, ["rev-parse", "HEAD"])).stdout.trim();
  return { work, bare, mainSha };
}

function coordinationWorkflow(
  workflowId: number,
  candidate: ActiveWorkflow["coordination"] extends infer C
    ? C extends { queueCandidate?: infer Q }
      ? Q
      : never
    : never,
  headSha = sha("a"),
): ActiveWorkflow {
  return {
    workflowId,
    title: `Workflow ${workflowId}`,
    targetBranch: "main",
    stage: "pr-opened",
    workerProfile: {
      provider: "test",
      modelId: "m",
      thinkingLevel: "off",
    },
    tickets: [workflowId + 100],
    integrationBranch: `matt-auto/${workflowId}/integration`,
    integratedTickets: [
      {
        number: workflowId + 100,
        attempt: 1,
        branchName: `matt-auto/${workflowId}/ticket-${workflowId + 100}/r1`,
      },
    ],
    workflowPr: {
      number: workflowId * 10,
      headBranch: `matt-auto/${workflowId}/integration`,
      baseBranch: "main",
    },
    coordination: {
      target,
      prFreshness: {
        headSha,
        mergeMethod: "merge",
      },
      ...(candidate ? { queueCandidate: candidate } : {}),
    },
  };
}

async function skillsPortWithResolveConflictsSkill(): Promise<
  ReturnType<typeof createSkillsPort>
> {
  const root = await mkdtemp(path.join(os.tmpdir(), "matt-skills-"));
  tempDirs.push(root);
  const skillDir = path.join(root, ".pi", "skills", "resolving-merge-conflicts");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", "name: resolving-merge-conflicts", "---", "", "Resolve merges."].join(
      "\n",
    ),
  );
  return createSkillsPort(root);
}

describe("Target-refresh skill context", () => {
  it("prepares ticket-to-Integration conflict prompts unchanged in shape", async () => {
    const skills = await skillsPortWithResolveConflictsSkill();
    const prepared = await skills.prepareResolveConflicts(
      ticketIntegrationConflictSkillInput({
        ticketNumber: 43,
        ticketBranch: "matt-auto/38/ticket-43/r1",
        integrationBranch: "matt-auto/38/integration",
      }),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.skillCommand).toMatch(/resolving-merge-conflicts/);
    expect(prepared.prompt).toContain("ticket #43");
    expect(prepared.prompt).toContain("matt-auto/38/ticket-43/r1");
    expect(prepared.prompt).not.toContain("Target-branch refresh");
  });

  it("prepares Target-refresh conflict context with target SHA and lease generation", async () => {
    const skills = await skillsPortWithResolveConflictsSkill();
    const prepared = await skills.prepareResolveConflicts(
      targetRefreshConflictSkillInput(
        {
          integrationBranch: "matt-auto/38/integration",
          integrationWorktreePath: "/tmp/integration",
          targetBranch: "main",
          targetSha: sha("c"),
          message: "conflict",
          targetLeaseGeneration: 7,
        },
        38,
      ),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prompt).toContain("Target-branch refresh");
    expect(prepared.prompt).toContain(`Expected target SHA: ${sha("c")}`);
    expect(prepared.prompt).toContain("Target-branch lease generation: 7");
    expect(prepared.prompt).toContain("Workflow ID: #38");
    expect(prepared.prompt).toContain("Do not push the Target branch");
  });
});

describe("Target-refresh workspace merge", () => {
  it("merges the latest Target tip into the Integration branch and records the Target SHA", async () => {
    const { work, bare, mainSha } = await createRefreshFixture();

    // Create Integration branch from main, then advance main on the remote.
    await git(work, ["checkout", "-b", "matt-auto/44/integration"]);
    await writeFile(path.join(work, "feature.txt"), "feature\n");
    await git(work, ["add", "feature.txt"]);
    await git(work, ["commit", "-m", "feature"]);
    await git(work, ["push", "-u", "origin", "matt-auto/44/integration"]);
    // Detach the main checkout from the Integration branch so worktree add can claim it.
    await git(work, ["checkout", "main"]);

    const other = path.join(path.dirname(work), "other");
    await git(path.dirname(work), ["clone", bare, other]);
    await writeFile(path.join(other, "main-new.txt"), "from-main\n");
    await git(other, ["add", "main-new.txt"]);
    await git(other, ["commit", "-m", "main advances"]);
    await git(other, ["push", "origin", "main"]);
    const newMainSha = (await git(other, ["rev-parse", "HEAD"])).stdout
      .trim()
      .toLowerCase();
    expect(newMainSha).not.toBe(mainSha.toLowerCase());

    // Integration worktree layout expected by WorkspacePort.
    const worktreeRoot = path.join(path.dirname(work), "matt-auto-workspaces", "44", "integration");
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    await git(work, [
      "worktree",
      "add",
      worktreeRoot,
      "matt-auto/44/integration",
    ]);

    const workspace = createWorkspacePort(work);
    const result = await workspace.refreshIntegrationFromTarget({
      workflowId: 44,
      targetBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetSha).toBe(newMainSha);
    expect(result.mergeCommitSha).toBeTruthy();

    // Feature commit and main tip both present; no rebase of Integration.
    const log = (await git(worktreeRoot, ["log", "--oneline"])).stdout;
    expect(log).toMatch(/feature/);
    expect(log).toMatch(/main advances|refresh from main/i);
    const hasMainFile = (
      await git(worktreeRoot, ["show", "HEAD:main-new.txt"])
    ).stdout;
    expect(hasMainFile).toContain("from-main");

    // Never advanced or rewrote the Target branch tip.
    const remoteMain = (
      await git(work, ["ls-remote", "origin", "refs/heads/main"])
    ).stdout.trim();
    expect(remoteMain.startsWith(newMainSha)).toBe(true);
  }, 30_000);

  it("preserves an in-progress merge on Target-refresh conflict and never aborts", async () => {
    const { work, bare } = await createRefreshFixture();

    await git(work, ["checkout", "-b", "matt-auto/44/integration"]);
    await writeFile(path.join(work, "conflict.txt"), "integration\n");
    await git(work, ["add", "conflict.txt"]);
    await git(work, ["commit", "-m", "integration side"]);
    await git(work, ["push", "-u", "origin", "matt-auto/44/integration"]);
    await git(work, ["checkout", "main"]);

    const other = path.join(path.dirname(work), "other");
    await git(path.dirname(work), ["clone", bare, other]);
    await writeFile(path.join(other, "conflict.txt"), "main\n");
    await git(other, ["add", "conflict.txt"]);
    await git(other, ["commit", "-m", "main side"]);
    await git(other, ["push", "origin", "main"]);
    const targetSha = (await git(other, ["rev-parse", "HEAD"])).stdout
      .trim()
      .toLowerCase();

    const worktreeRoot = path.join(path.dirname(work), "matt-auto-workspaces", "44", "integration");
    await mkdir(path.dirname(worktreeRoot), { recursive: true });
    await git(work, [
      "worktree",
      "add",
      worktreeRoot,
      "matt-auto/44/integration",
    ]);

    const workspace = createWorkspacePort(work);
    const result = await workspace.refreshIntegrationFromTarget({
      workflowId: 44,
      targetBranch: "main",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "conflict",
      targetSha,
    });

    // Merge still in progress for Conflict resolution worker.
    const mergeHead = await git(worktreeRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    expect(mergeHead.stdout.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it("classifies workspace outcomes for the coordinator delivery phase", () => {
    expect(
      classifyTargetRefreshResult({
        result: {
          ok: true,
          targetSha: sha("d"),
          mergeCommitSha: sha("e"),
        },
        integrationBranch: "matt-auto/1/integration",
        integrationWorktreePath: "/tmp/i",
        targetBranch: "main",
      }),
    ).toMatchObject({
      status: "merged",
      targetSha: sha("d"),
    });

    expect(
      classifyTargetRefreshResult({
        result: {
          ok: false,
          reason: "conflict",
          message: "conflict",
          targetSha: sha("f"),
        },
        integrationBranch: "matt-auto/1/integration",
        integrationWorktreePath: "/tmp/i",
        targetBranch: "main",
        targetLeaseGeneration: 3,
      }),
    ).toMatchObject({
      status: "conflict",
      conflict: {
        targetSha: sha("f"),
        targetLeaseGeneration: 3,
      },
    });

    expect(
      classifyTargetRefreshResult({
        result: { ok: false, reason: "error", message: "fetch failed" },
        integrationBranch: "matt-auto/1/integration",
        integrationWorktreePath: "/tmp/i",
        targetBranch: "main",
      }),
    ).toMatchObject({
      status: "failed",
      failureKind: "transient",
      failureReasonCode: TARGET_REFRESH_FAILURE_REASONS.mergeError,
    });
  });
});

describe("Target-refresh queue persistence", () => {
  async function acquireWorkflowLease(
    coordination: ReturnType<typeof createFakeCoordinationPort>,
    holderId: string,
    workflowId: number,
  ): Promise<WorkflowCoordinatorLease> {
    const acquired = await coordination.acquireLease({
      kind: "workflow-coordinator",
      repository: target.repository,
      target,
      workflowId,
      holderId,
      ttlMs: 60_000,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired || acquired.lease.kind !== "workflow-coordinator") {
      throw new Error("expected workflow coordinator lease");
    }
    return acquired.lease;
  }

  it("persists validatedTargetSha with queue facts when releasing for PR checks", async () => {
    const coordination = createFakeCoordinationPort();
    const state = new Map<number, ActiveWorkflow>();
    state.set(
      44,
      coordinationWorkflow(44, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    );
    const store = {
      listActiveWorkflows: async () => [...state.values()],
      writeWorkflowManifest: async (workflowId: number, manifest: WorkflowManifest) => {
        const current = state.get(workflowId);
        if (!current || manifest.version !== 2) return;
        state.set(workflowId, {
          ...current,
          coordination: manifest.coordination,
        });
      },
    };
    const lease = await acquireWorkflowLease(coordination, "home-44", 44);
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 44,
      holderId: "home-44",
      coordination,
      store,
    });

    const acquired = await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease,
      phase: "refresh",
    });
    expect(acquired).toMatchObject({ ok: true, action: "target-lease-acquired" });

    const headSha = sha("9");
    const validatedTargetSha = sha("8");
    const released = await releaseTargetRefreshForPrChecks({
      queue,
      workflowCoordinatorLease: lease,
      prFreshness: refreshedWorkflowPrFreshness({
        headSha,
        validatedTargetSha,
        mergeMethod: "merge",
      }),
    });
    expect(released).toEqual({ ok: true });

    const updated = state.get(44);
    expect(updated?.coordination?.prFreshness).toEqual({
      headSha,
      validatedTargetSha,
      mergeMethod: "merge",
    });
    expect(updated?.coordination?.queueCandidate).toEqual({
      state: "awaiting-pr-checks",
    });
    expect(queue.getHeldTargetBranchLease()).toBeUndefined();
  });

  it("releases the Target-branch lease and records a retryable failure", async () => {
    const coordination = createFakeCoordinationPort();
    const state = new Map<number, ActiveWorkflow>();
    state.set(
      44,
      coordinationWorkflow(44, {
        state: "merge-ready",
        mergeReadyAt: "2026-07-28T16:00:00.000Z",
      }),
    );
    const store = {
      listActiveWorkflows: async () => [...state.values()],
      writeWorkflowManifest: async (workflowId: number, manifest: WorkflowManifest) => {
        const current = state.get(workflowId);
        if (!current || manifest.version !== 2) return;
        state.set(workflowId, {
          ...current,
          coordination: manifest.coordination,
        });
      },
    };
    const lease = await acquireWorkflowLease(coordination, "home-44", 44);
    const queue = createTargetBranchQueueOrchestrator({
      target,
      workflowId: 44,
      holderId: "home-44",
      coordination,
      store,
    });
    await queue.transition({
      kind: "acquire-phase",
      workflowCoordinatorLease: lease,
      phase: "refresh",
    });
    expect(queue.getHeldTargetBranchLease()).toBeTruthy();

    const failed = await recordTargetRefreshFailure({
      queue,
      workflowCoordinatorLease: lease,
      failureKind: "deterministic",
      reason: TARGET_REFRESH_FAILURE_REASONS.localVerificationFailed,
    });
    expect(failed).toEqual({ ok: true });
    expect(queue.getHeldTargetBranchLease()).toBeUndefined();
    expect(state.get(44)?.coordination?.queueCandidate).toMatchObject({
      state: "retryable",
      retry: {
        reason: TARGET_REFRESH_FAILURE_REASONS.localVerificationFailed,
      },
    });
  });
});

describe("mergeTargetIntoIntegration helper", () => {
  it("delegates to WorkspacePort.refreshIntegrationFromTarget without rebasing", async () => {
    const calls: Array<{ workflowId: number; targetBranch: string }> = [];
    const workspace = {
      refreshIntegrationFromTarget: async (input: {
        workflowId: number;
        targetBranch: string;
      }) => {
        calls.push(input);
        return {
          ok: true as const,
          targetSha: sha("1"),
          mergeCommitSha: sha("2"),
        };
      },
    };

    const result = await mergeTargetIntoIntegration({
      workspace: workspace as never,
      workflowId: 44,
      targetBranch: "main",
      integrationBranch: "matt-auto/44/integration",
      integrationWorktreePath: "/tmp/i",
      targetLeaseGeneration: 2,
    });

    expect(calls).toEqual([{ workflowId: 44, targetBranch: "main" }]);
    expect(result).toMatchObject({
      status: "merged",
      targetSha: sha("1"),
    });
  });
});
