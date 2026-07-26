import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowCoordinator } from "../src/coordinator.js";
import type {
  CiCheckResult,
  CiPort,
  CreateSpecSkillOutcome,
  CreateTicketsSkillOutcome,
  EnvironmentPort,
  GitTopologyPort,
  LocalVerificationResult,
  ModelsPort,
  NestedGitRepository,
  PreferencesPort,
  PrepareImplementOutcome,
  RemoteGitPort,
  RootScopedPorts,
  SkillsPort,
  TrackerPort,
  TrackerTicket,
  TranscriptPort,
  VerificationPort,
  WorkerEventSink,
  WorkerLaunchInput,
  WorkersPort,
  WorkspacePort,
  WorkflowCoordinatorPorts,
} from "../src/ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  SpecDraft,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowManifest,
} from "../src/types.js";
import {
  checkCiActionId,
  ciRecoveryActionId,
  CLEANUP_WORKFLOW_ACTION,
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DEFAULT_TARGET_BRANCH,
  dispositionActionId,
  IMPLEMENTATION_DISPOSITION_OPTIONS,
  implementTicketActionId,
  implementationBranchName,
  integrateTicketActionId,
  integrationBranchName,
  MERGE_WORKFLOW_PR_ACTION,
  NO_GIT_REPOSITORY_REASON,
  OPEN_WORKFLOW_PR_ACTION,
  REQUIRED_MATT_SKILLS,
  reworkTicketActionId,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
  START_FOLLOW_UP_ACTION,
  TICKET_ISSUE_LABEL,
  TICKET_PROGRESS_ACTION,
  UNSUPPORTED_TRACKER_REASON,
  WORKFLOW_MANIFEST_SCHEMA,
} from "../src/constants.js";

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

const defaultSpecDraft: SpecDraft = {
  title: "Ship feature X",
  body: [
    "## Problem Statement",
    "Users need feature X so they can complete their primary workflow without workarounds.",
    "",
    "## Solution",
    "Ship a focused first slice of feature X with tests at the coordinator seam.",
  ].join("\n"),
};

const defaultTicketsDraft: TicketsDraft = {
  tickets: [
    {
      localId: "1",
      title: "Ship core path",
      body: "## What to build\n\nCore end-to-end path.\n",
      blockedBy: [],
    },
    {
      localId: "2",
      title: "Ship dependent path",
      body: "## What to build\n\nDepends on core.\n",
      blockedBy: ["1"],
    },
    {
      localId: "3",
      title: "Ship parallel path",
      body: "## What to build\n\nIndependent of core.\n",
      blockedBy: [],
    },
  ],
};

type SkillsFixture = {
  names?: readonly string[];
  createSpecOutcomes?: CreateSpecSkillOutcome[];
  createTicketsOutcomes?: CreateTicketsSkillOutcome[];
  prepareImplementOutcome?: PrepareImplementOutcome;
  prepareResolveConflictsOutcome?: PrepareImplementOutcome;
  calls?: {
    runCreateSpec: number;
    runCreateTickets: number;
    prepareImplement?: number;
    prepareResolveConflicts?: number;
  };
};

function createSkills(fixture: SkillsFixture = {}): SkillsPort {
  const names = fixture.names ?? [...REQUIRED_MATT_SKILLS];
  const specOutcomes = fixture.createSpecOutcomes ?? [
    { ok: true as const, draft: defaultSpecDraft },
  ];
  const ticketsOutcomes = fixture.createTicketsOutcomes ?? [
    { ok: true as const, draft: defaultTicketsDraft },
  ];
  let specIndex = 0;
  let ticketsIndex = 0;
  const calls = fixture.calls ?? {
    runCreateSpec: 0,
    runCreateTickets: 0,
    prepareImplement: 0,
    prepareResolveConflicts: 0,
  };
  const callBag = calls as {
    runCreateSpec: number;
    runCreateTickets: number;
    prepareImplement?: number;
    prepareResolveConflicts?: number;
  };
  if (callBag.prepareImplement === undefined) callBag.prepareImplement = 0;
  if (callBag.prepareResolveConflicts === undefined) callBag.prepareResolveConflicts = 0;

  return {
    installedSkillNames: async () => names,
    runCreateSpec: async () => {
      calls.runCreateSpec += 1;
      const index = Math.min(specIndex, specOutcomes.length - 1);
      specIndex += 1;
      const outcome = specOutcomes[index];
      if (!outcome) return { ok: false, reason: "No Create-spec skill outcome configured." };
      return outcome;
    },
    runCreateTickets: async () => {
      calls.runCreateTickets += 1;
      const index = Math.min(ticketsIndex, ticketsOutcomes.length - 1);
      ticketsIndex += 1;
      const outcome = ticketsOutcomes[index];
      if (!outcome) return { ok: false, reason: "No Create-tickets skill outcome configured." };
      return outcome;
    },
    prepareImplement: async (input) => {
      callBag.prepareImplement = (callBag.prepareImplement ?? 0) + 1;
      if (fixture.prepareImplementOutcome) return fixture.prepareImplementOutcome;
      if (!names.includes("implement")) return { ok: false, reason: "Installed skill implement is missing." };
      return {
        ok: true,
        skillCommand: "/implement",
        prompt: `/implement\n\nImplement #${input.ticketNumber}: ${input.title}`,
      };
    },
    prepareResolveConflicts: async (input) => {
      callBag.prepareResolveConflicts = (callBag.prepareResolveConflicts ?? 0) + 1;
      if (fixture.prepareResolveConflictsOutcome) return fixture.prepareResolveConflictsOutcome;
      if (!names.includes("resolving-merge-conflicts")) {
        return { ok: false, reason: "Installed skill resolving-merge-conflicts is missing." };
      }
      return {
        ok: true,
        skillCommand: "/resolving-merge-conflicts",
        prompt: [
          `/resolving-merge-conflicts`,
          "",
          `Resolve conflict for #${input.ticketNumber}`,
          `Ticket branch: ${input.ticketBranch}`,
          `Integration branch: ${input.integrationBranch}`,
        ].join("\n"),
      };
    },
  };
}

type WorkspaceState = {
  creates: Array<{
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    baseRef: string;
    branchName: string;
    worktreePath: string;
  }>;
  ensures: Array<{
    workflowId: number;
    ticketNumber: number;
    attempt: number;
    baseRef: string;
    branchName: string;
    worktreePath: string;
  }>;
  integrationEnsures: Array<{
    workflowId: number;
    baseRef: string;
    branchName: string;
    worktreePath: string;
  }>;
  merges: Array<{
    workflowId: number;
    ticketBranch: string;
  }>;
  attempts: Map<string, number>;
  cleanupCalls: number[];
  listBranchesCalls: number[];
  removeLocalBranchesCalls: string[][];
  removedBranches: Set<string>;
  failCreate?: boolean;
  failEnsureIntegration?: boolean;
  mergeResult?:
    | { ok: true; mergeCommitSha?: string }
    | { ok: false; reason: "conflict" | "error"; message: string };
};

function createWorkspace(
  workflowRoot = "/repo",
  initial: {
    attempts?: Map<string, number>;
    failCreate?: boolean;
    failEnsureIntegration?: boolean;
    mergeResult?: WorkspaceState["mergeResult"];
  } = {},
): { port: WorkspacePort; state: WorkspaceState } {
  const state: WorkspaceState = {
    creates: [],
    ensures: [],
    integrationEnsures: [],
    merges: [],
    attempts: initial.attempts ?? new Map(),
    cleanupCalls: [],
    listBranchesCalls: [],
    removeLocalBranchesCalls: [],
    removedBranches: new Set(),
    ...(initial.failCreate !== undefined
      ? { failCreate: initial.failCreate }
      : {}),
    ...(initial.failEnsureIntegration !== undefined
      ? { failEnsureIntegration: initial.failEnsureIntegration }
      : {}),
    ...(initial.mergeResult !== undefined
      ? { mergeResult: initial.mergeResult }
      : {}),
  };

  const port: WorkspacePort = {
    latestAttempt: async (workflowId, ticketNumber) => {
      return state.attempts.get(`${workflowId}:${ticketNumber}`) ?? 0;
    },
    createImplementationWorkspace: async (input) => {
      if (state.failCreate) {
        throw new Error("worktree create failed");
      }
      const branchName = implementationBranchName(
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      );
      // Sibling of Workflow root — outside the root path.
      const worktreePath = path.join(
        path.dirname(workflowRoot),
        "matt-auto-workspaces",
        String(input.workflowId),
        `ticket-${input.ticketNumber}`,
        `r${input.attempt}`,
      );
      state.creates.push({
        ...input,
        branchName,
        worktreePath,
      });
      state.attempts.set(
        `${input.workflowId}:${input.ticketNumber}`,
        input.attempt,
      );
      state.removedBranches.delete(branchName);
      return { branchName, worktreePath };
    },
    ensureImplementationWorkspace: async (input) => {
      const branchName = implementationBranchName(
        input.workflowId,
        input.ticketNumber,
        input.attempt,
      );
      const worktreePath = path.join(
        path.dirname(workflowRoot),
        "matt-auto-workspaces",
        String(input.workflowId),
        `ticket-${input.ticketNumber}`,
        `r${input.attempt}`,
      );
      state.ensures.push({
        ...input,
        branchName,
        worktreePath,
      });
      // Reuse existing attempt workspace when not discarded; otherwise create.
      if (!state.removedBranches.has(branchName)) {
        const existing = state.creates.find(
          (c) =>
            c.workflowId === input.workflowId &&
            c.ticketNumber === input.ticketNumber &&
            c.attempt === input.attempt,
        );
        if (existing) {
          state.attempts.set(
            `${input.workflowId}:${input.ticketNumber}`,
            Math.max(
              state.attempts.get(`${input.workflowId}:${input.ticketNumber}`) ??
                0,
              input.attempt,
            ),
          );
          return {
            branchName: existing.branchName,
            worktreePath: existing.worktreePath,
          };
        }
      }
      return port.createImplementationWorkspace(input);
    },
    ensureIntegrationWorkspace: async (input) => {
      if (state.failEnsureIntegration) {
        throw new Error("integration worktree create failed");
      }
      const branchName = integrationBranchName(input.workflowId);
      const worktreePath = path.join(
        path.dirname(workflowRoot),
        "matt-auto-workspaces",
        String(input.workflowId),
        "integration",
      );
      state.integrationEnsures.push({
        workflowId: input.workflowId,
        baseRef: input.baseRef,
        branchName,
        worktreePath,
      });
      state.removedBranches.delete(branchName);
      return { branchName, worktreePath };
    },
    mergeIntoIntegration: async (input) => {
      state.merges.push({
        workflowId: input.workflowId,
        ticketBranch: input.ticketBranch,
      });
      if (state.mergeResult) {
        return state.mergeResult;
      }
      return { ok: true, mergeCommitSha: "merge-sha-1" };
    },
    listWorkflowBranches: async (workflowId) => {
      state.listBranchesCalls.push(workflowId);
      const branches = new Set<string>();
      const integration = integrationBranchName(workflowId);
      if (!state.removedBranches.has(integration)) {
        // Only list Integration branch once it has been ensured or still present.
        if (
          state.integrationEnsures.some((e) => e.workflowId === workflowId) ||
          state.creates.some((c) => c.workflowId === workflowId)
        ) {
          branches.add(integration);
        }
      }
      for (const create of state.creates) {
        if (
          create.workflowId === workflowId &&
          !state.removedBranches.has(create.branchName)
        ) {
          branches.add(create.branchName);
        }
      }
      return [...branches].sort();
    },
    removeLocalBranches: async (branchNames) => {
      state.removeLocalBranchesCalls.push([...branchNames]);
      const removedLocalBranches: string[] = [];
      const removedWorktrees: string[] = [];
      for (const branch of branchNames) {
        state.removedBranches.add(branch);
        removedLocalBranches.push(branch);
        removedWorktrees.push(
          `/matt-auto-workspaces/${branch.replace(/\//g, "-")}`,
        );
        // Reset latestAttempt counters for discarded ticket attempts.
        const match = /^matt-auto\/(\d+)\/ticket-(\d+)\/r(\d+)$/.exec(branch);
        if (match) {
          const workflowId = Number(match[1]);
          const ticketNumber = Number(match[2]);
          const attempt = Number(match[3]);
          const key = `${workflowId}:${ticketNumber}`;
          const current = state.attempts.get(key) ?? 0;
          if (attempt >= current) {
            // Recompute max remaining attempt for this ticket.
            let max = 0;
            for (const create of state.creates) {
              if (
                create.workflowId === workflowId &&
                create.ticketNumber === ticketNumber &&
                !state.removedBranches.has(create.branchName)
              ) {
                max = Math.max(max, create.attempt);
              }
            }
            if (max > 0) state.attempts.set(key, max);
            else state.attempts.delete(key);
          }
        }
      }
      return { removedLocalBranches, removedWorktrees };
    },
    cleanupWorkflowWorkspaces: async (workflowId) => {
      state.cleanupCalls.push(workflowId);
      const branches = await port.listWorkflowBranches(workflowId);
      return port.removeLocalBranches(branches);
    },
    hasCommitsAhead: async () => ({ ahead: false, count: 0 }),
  };

  return { port, state };
}

type VerificationState = {
  calls: string[];
  result: LocalVerificationResult;
};

function createVerification(
  initial: { result?: LocalVerificationResult } = {},
): { port: VerificationPort; state: VerificationState } {
  const state: VerificationState = {
    calls: [],
    result: initial.result ?? { ok: true, commands: ["npm test"] },
  };
  return {
    state,
    port: {
      runLocalVerification: async (worktreePath) => {
        state.calls.push(worktreePath);
        return state.result;
      },
    },
  };
}

type RemoteGitState = {
  pushes: string[];
  deleted: string[][];
  failPush?: boolean;
  failDelete?: boolean;
};

function createRemoteGit(
  initial: { failPush?: boolean; failDelete?: boolean } = {},
): { port: RemoteGitPort; state: RemoteGitState } {
  const state: RemoteGitState = {
    pushes: [],
    deleted: [],
    ...(initial.failPush !== undefined ? { failPush: initial.failPush } : {}),
    ...(initial.failDelete !== undefined
      ? { failDelete: initial.failDelete }
      : {}),
  };
  return {
    state,
    port: {
      pushBranch: async (branchName) => {
        if (state.failPush) {
          throw new Error(`push failed for ${branchName}`);
        }
        state.pushes.push(branchName);
      },
      deleteRemoteBranches: async (branchNames) => {
        if (state.failDelete) {
          throw new Error(`delete remote failed for ${branchNames.join(", ")}`);
        }
        state.deleted.push([...branchNames]);
      },
    },
  };
}

type CiState = {
  checks: string[];
  result: CiCheckResult;
};

function createCi(
  initial: { result?: CiCheckResult } = {},
): { port: CiPort; state: CiState } {
  const state: CiState = {
    checks: [],
    result: initial.result ?? { status: "pending", summary: "CI pending" },
  };
  return {
    state,
    port: {
      checkStatus: async (input) => {
        state.checks.push(input.branchName);
        return state.result;
      },
    },
  };
}


type WorkersState = {
  launches: WorkerLaunchInput[];
  aborts: string[];
  abortAllCount: number;
  sinks: Map<string, WorkerEventSink>;
  failLaunch?: boolean;
};

function createWorkers(
  initial: { failLaunch?: boolean } = {},
): {
  port: WorkersPort;
  state: WorkersState;
  emit: (workerId: string, event: WorkerProtocolEvent) => Promise<void>;
} {
  const state: WorkersState = {
    launches: [],
    aborts: [],
    abortAllCount: 0,
    sinks: new Map(),
    ...(initial.failLaunch !== undefined
      ? { failLaunch: initial.failLaunch }
      : {}),
  };

  const port: WorkersPort = {
    launch: async (input, sink) => {
      if (state.failLaunch) {
        throw new Error("worker launch failed");
      }
      state.launches.push(input);
      state.sinks.set(input.workerId, sink);
      // Synthetic pid so panel inspection + process-gone logic can run in tests.
      return { workerId: input.workerId, pid: 4242, alive: true };
    },
    getRuntime: (workerId) => {
      if (!state.sinks.has(workerId)) return undefined;
      // Stay "alive" until the test emits process-exit / abort clears the sink.
      return { workerId, pid: 4242, alive: true };
    },
    abort: async (workerId) => {
      state.aborts.push(workerId);
      state.sinks.delete(workerId);
    },
    abortAll: async () => {
      state.abortAllCount += 1;
      for (const id of state.sinks.keys()) {
        state.aborts.push(id);
      }
      state.sinks.clear();
    },
  };

  return {
    port,
    state,
    emit: async (workerId, event) => {
      const sink = state.sinks.get(workerId);
      if (!sink) {
        throw new Error(`No sink for worker ${workerId}`);
      }
      await sink.onEvent(event);
    },
  };
}

function createTranscripts(): {
  port: TranscriptPort;
  state: Map<string, unknown[]>;
  cleanupCalls: number[];
} {
  const state = new Map<string, unknown[]>();
  const cleanupCalls: number[] = [];
  const keyOf = (key: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }) => `${key.workflowId}:${key.ticketNumber}:r${key.attempt}`;

  return {
    state,
    cleanupCalls,
    port: {
      append: async (key, event) => {
        const k = keyOf(key);
        const list = state.get(k) ?? [];
        list.push(event);
        state.set(k, list);
      },
      read: async (key) => state.get(keyOf(key)) ?? [],
      cleanupWorkflowTranscripts: async (workflowId) => {
        cleanupCalls.push(workflowId);
        for (const key of [...state.keys()]) {
          if (key.startsWith(`${workflowId}:`)) {
            state.delete(key);
          }
        }
      },
    },
  };
}

type TrackerState = {
  issues: Array<{
    number: number;
    title: string;
    body: string;
    labels: string[];
    state: "OPEN" | "CLOSED";
    blockedBy: number[];
    parent?: number;
  }>;
  manifests: Map<number, WorkflowManifest>;
  pullRequests: Array<{
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    merged: boolean;
    url: string;
  }>;
  createIssueCalls: number;
  writeManifestCalls: number;
  closeIssueCalls: number[];
  closeIssueComments: Array<{ number: number; comment: string }>;
  reopenIssueCalls: number[];
  createPrCalls: Array<{ head: string; base: string; title: string }>;
  mergePrCalls: number[];
  addBlockedByCalls: Array<{ issue: number; blocker: number }>;
  addSubIssueCalls: Array<{ parent: number; child: number }>;
  nextNumber: number;
  nextPrNumber: number;
};

function createTracker(
  initial: {
    active?: ActiveWorkflow;
    failCreate?: boolean;
    failWriteManifest?: boolean;
    /** Extra ticket issues already on GitHub (for frontier tests). */
    tickets?: Array<{
      number: number;
      title: string;
      state?: "OPEN" | "CLOSED";
      blockedBy?: number[];
    }>;
  } = {},
): { port: TrackerPort; state: TrackerState } {
  const state: TrackerState = {
    issues: [],
    manifests: new Map(),
    pullRequests: [],
    createIssueCalls: 0,
    writeManifestCalls: 0,
    closeIssueCalls: [],
    closeIssueComments: [],
    reopenIssueCalls: [],
    createPrCalls: [],
    mergePrCalls: [],
    addBlockedByCalls: [],
    addSubIssueCalls: [],
    nextNumber: 100,
    nextPrNumber: 500,
  };

  if (initial.active) {
    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: initial.active.workflowId,
      targetBranch: initial.active.targetBranch,
      stage: initial.active.stage,
      workerProfile: initial.active.workerProfile,
    };
    if (initial.active.tickets) {
      manifest.tickets = [...initial.active.tickets];
    }
    if (initial.active.integrationBranch) {
      manifest.integrationBranch = initial.active.integrationBranch;
    }
    if (initial.active.integratedTickets) {
      manifest.integratedTickets = [...initial.active.integratedTickets];
    }
    if (initial.active.workflowPr) {
      manifest.workflowPr = { ...initial.active.workflowPr };
    }
    if (initial.active.followUpOf !== undefined) {
      manifest.followUpOf = initial.active.followUpOf;
    }
    state.manifests.set(initial.active.workflowId, manifest);
    state.issues.push({
      number: initial.active.workflowId,
      title: initial.active.title ?? "Existing workflow",
      body: "spec",
      labels: [SPEC_ISSUE_LABEL],
      state: "OPEN",
      blockedBy: [],
    });
    state.nextNumber = initial.active.workflowId + 1;
  }

  for (const ticket of initial.tickets ?? []) {
    const issue: TrackerState["issues"][number] = {
      number: ticket.number,
      title: ticket.title,
      body: "ticket",
      labels: [TICKET_ISSUE_LABEL],
      state: ticket.state ?? "OPEN",
      blockedBy: [...(ticket.blockedBy ?? [])],
    };
    if (initial.active?.workflowId !== undefined) {
      issue.parent = initial.active.workflowId;
    }
    state.issues.push(issue);
    state.nextNumber = Math.max(state.nextNumber, ticket.number + 1);
  }

  const port: TrackerPort = {
    createIssue: async (input) => {
      state.createIssueCalls += 1;
      if (initial.failCreate) {
        throw new Error("GitHub createIssue failed");
      }
      const number = state.nextNumber++;
      state.issues.push({
        number,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
        state: "OPEN",
        blockedBy: [],
      });
      return { number };
    },
    writeWorkflowManifest: async (issueNumber, manifest) => {
      state.writeManifestCalls += 1;
      if (initial.failWriteManifest) {
        throw new Error("GitHub writeWorkflowManifest failed");
      }
      state.manifests.set(issueNumber, manifest);
    },
    findActiveWorkflow: async (targetBranch) => {
      for (const manifest of state.manifests.values()) {
        if (manifest.targetBranch !== targetBranch) continue;
        if (manifest.stage === "completed") continue;
        const issue = state.issues.find((i) => i.number === manifest.workflowId);
        const active: ActiveWorkflow = {
          workflowId: manifest.workflowId,
          targetBranch: manifest.targetBranch,
          stage: manifest.stage,
          workerProfile: manifest.workerProfile,
        };
        if (manifest.tickets) {
          active.tickets = [...manifest.tickets];
        }
        if (manifest.integrationBranch) {
          active.integrationBranch = manifest.integrationBranch;
        }
        if (manifest.integratedTickets) {
          active.integratedTickets = [...manifest.integratedTickets];
        }
        if (manifest.workflowPr) {
          active.workflowPr = { ...manifest.workflowPr };
        }
        if (manifest.followUpOf !== undefined) {
          active.followUpOf = manifest.followUpOf;
        }
        if (issue?.title) {
          active.title = issue.title;
        }
        return active;
      }
      return undefined;
    },
    listTickets: async (issueNumbers) => {
      const wanted = new Set(issueNumbers);
      const tickets: TrackerTicket[] = [];
      for (const issue of state.issues) {
        if (!wanted.has(issue.number)) continue;
        tickets.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          blockedBy: issue.blockedBy.map((n) => {
            const blocker = state.issues.find((i) => i.number === n);
            return {
              number: n,
              state: blocker?.state ?? "OPEN",
            };
          }),
        });
      }
      return tickets;
    },
    closeIssue: async (issueNumber, options) => {
      state.closeIssueCalls.push(issueNumber);
      if (options?.comment) {
        state.closeIssueComments.push({
          number: issueNumber,
          comment: options.comment,
        });
      }
      const issue = state.issues.find((i) => i.number === issueNumber);
      if (issue) issue.state = "CLOSED";
    },
    reopenIssue: async (issueNumber) => {
      state.reopenIssueCalls.push(issueNumber);
      const issue = state.issues.find((i) => i.number === issueNumber);
      if (issue) issue.state = "OPEN";
    },
    createPullRequest: async (input) => {
      state.createPrCalls.push({
        head: input.head,
        base: input.base,
        title: input.title,
      });
      const number = state.nextPrNumber++;
      const url = `https://example.test/pr/${number}`;
      state.pullRequests.push({
        number,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        merged: false,
        url,
      });
      return { number, url };
    },
    mergePullRequest: async (input) => {
      state.mergePrCalls.push(input.number);
      const pr = state.pullRequests.find((p) => p.number === input.number);
      if (!pr) {
        throw new Error(`PR #${input.number} not found`);
      }
      pr.merged = true;
    },
    addBlockedBy: async (issueNumber, blockerIssueNumber) => {
      state.addBlockedByCalls.push({
        issue: issueNumber,
        blocker: blockerIssueNumber,
      });
      const issue = state.issues.find((i) => i.number === issueNumber);
      if (issue && !issue.blockedBy.includes(blockerIssueNumber)) {
        issue.blockedBy.push(blockerIssueNumber);
      }
    },
    addSubIssue: async (parentIssueNumber, childIssueNumber) => {
      state.addSubIssueCalls.push({
        parent: parentIssueNumber,
        child: childIssueNumber,
      });
      const child = state.issues.find((i) => i.number === childIssueNumber);
      if (child) {
        child.parent = parentIssueNumber;
      }
    },
  };

  return { port, state };
}

type PrefState = {
  targetBranch?: string;
  globalWorkerProfile?: WorkerProfile;
  rootWorkerProfile?: WorkerProfile;
  snapshotWorkerProfile?: WorkerProfile;
  activeWorkflowIds?: Record<string, number>;
};

function createPreferences(state: PrefState = {}): PreferencesPort {
  const store: PrefState = {
    ...state,
    activeWorkflowIds: { ...(state.activeWorkflowIds ?? {}) },
  };
  return {
    getConfiguredTargetBranch: async () => store.targetBranch,
    getGlobalWorkerProfile: async () => store.globalWorkerProfile,
    getRootWorkerProfile: async () => store.rootWorkerProfile,
    getWorkflowSnapshotWorkerProfile: async () => store.snapshotWorkerProfile,
    setGlobalWorkerProfile: async (profile) => {
      store.globalWorkerProfile = profile;
    },
    setRootWorkerProfile: async (profile) => {
      store.rootWorkerProfile = profile;
    },
    clearRootWorkerProfile: async () => {
      delete store.rootWorkerProfile;
    },
    getActiveWorkflowId: async (targetBranch) =>
      store.activeWorkflowIds?.[targetBranch],
    setActiveWorkflowId: async (targetBranch, workflowId) => {
      store.activeWorkflowIds = {
        ...(store.activeWorkflowIds ?? {}),
        [targetBranch]: workflowId,
      };
    },
    clearActiveWorkflowId: async (targetBranch) => {
      if (!store.activeWorkflowIds?.[targetBranch]) return;
      const { [targetBranch]: _removed, ...rest } = store.activeWorkflowIds;
      store.activeWorkflowIds = rest;
    },
  };
}

const defaultWorkerProfile: WorkerProfile = {
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  thinkingLevel: "medium",
};

const reasoningModel: AvailableModel = {
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  label: "anthropic/claude-sonnet-4",
  thinkingLevels: ["off", "minimal", "low", "medium", "high"],
};

const noReasoningModel: AvailableModel = {
  provider: "openai",
  modelId: "gpt-4o",
  label: "openai/gpt-4o",
  thinkingLevels: ["off"],
};

function createModels(
  models: readonly AvailableModel[] = [reasoningModel, noReasoningModel],
): ModelsPort {
  return {
    listAvailableModels: async () => models,
    getHomeModel: async () => undefined,
  };
}

type RootFixture = {
  environment?: Partial<EnvironmentPort>;
  skills?: SkillsFixture;
  /** Shorthand for skills.names when only installed names matter. */
  skillNames?: readonly string[];
  preferences?: PrefState;
  tracker?: ReturnType<typeof createTracker>;
  workspace?: ReturnType<typeof createWorkspace>;
  workers?: ReturnType<typeof createWorkers>;
  transcripts?: ReturnType<typeof createTranscripts>;
  verification?: ReturnType<typeof createVerification>;
  remoteGit?: ReturnType<typeof createRemoteGit>;
  ci?: ReturnType<typeof createCi>;
};

function createTopology(
  overrides: {
    nearest?: string | undefined;
    nested?: readonly NestedGitRepository[];
  } = {},
): GitTopologyPort {
  const nearest =
    "nearest" in overrides ? overrides.nearest : "/repo";
  const nested = overrides.nested ?? [];
  return {
    nearestGitRoot: async () => nearest,
    nestedGitRepositories: async () => nested,
  };
}

function createPorts(
  overrides: {
    startPath?: string;
    topology?: GitTopologyPort;
    models?: ModelsPort;
    /** Per-root fixture overrides keyed by absolute path. */
    roots?: Record<string, RootFixture>;
    defaultRoot?: RootFixture;
  } = {},
): WorkflowCoordinatorPorts & {
  /** Default-root tracker state when the fixture provided one. */
  __defaultTracker?: ReturnType<typeof createTracker>;
  __defaultWorkspace?: ReturnType<typeof createWorkspace>;
  __defaultWorkers?: ReturnType<typeof createWorkers>;
  __defaultTranscripts?: ReturnType<typeof createTranscripts>;
} {
  const startPath = overrides.startPath ?? "/repo";
  const defaultRoot: RootFixture = overrides.defaultRoot ?? {
    preferences: { globalWorkerProfile: defaultWorkerProfile },
  };
  const roots = overrides.roots ?? {};
  const defaultTracker = defaultRoot.tracker ?? createTracker();
  const defaultWorkspace = defaultRoot.workspace ?? createWorkspace("/repo");
  const defaultWorkers = defaultRoot.workers ?? createWorkers();
  const defaultTranscripts = defaultRoot.transcripts ?? createTranscripts();
  const defaultVerification = defaultRoot.verification ?? createVerification();
  const defaultRemoteGit = defaultRoot.remoteGit ?? createRemoteGit();
  const defaultCi = defaultRoot.ci ?? createCi();

  return {
    startPath,
    topology: overrides.topology ?? createTopology({ nearest: "/repo" }),
    models: overrides.models ?? createModels(),
    __defaultTracker: defaultTracker,
    __defaultWorkspace: defaultWorkspace,
    __defaultWorkers: defaultWorkers,
    __defaultTranscripts: defaultTranscripts,
    forRoot(rootPath: string): RootScopedPorts {
      const fixture = roots[rootPath] ?? defaultRoot;
      const skillsFixture: SkillsFixture = fixture.skills
        ? fixture.skills
        : fixture.skillNames
          ? { names: fixture.skillNames }
          : {};
      const tracker = fixture.tracker ?? defaultTracker;
      const workspace =
        fixture.workspace ??
        (fixture === defaultRoot
          ? defaultWorkspace
          : createWorkspace(rootPath));
      const workers =
        fixture.workers ??
        (fixture === defaultRoot ? defaultWorkers : createWorkers());
      const transcripts =
        fixture.transcripts ??
        (fixture === defaultRoot ? defaultTranscripts : createTranscripts());
      const verification =
        fixture.verification ??
        (fixture === defaultRoot ? defaultVerification : createVerification());
      const remoteGit =
        fixture.remoteGit ??
        (fixture === defaultRoot ? defaultRemoteGit : createRemoteGit());
      const ci =
        fixture.ci ?? (fixture === defaultRoot ? defaultCi : createCi());
      return {
        environment: createEnvironment(fixture.environment),
        skills: createSkills(skillsFixture),
        preferences: createPreferences(
          fixture.preferences ?? {
            globalWorkerProfile: defaultWorkerProfile,
          },
        ),
        tracker: tracker.port,
        workspace: workspace.port,
        workers: workers.port,
        transcripts: transcripts.port,
        verification: verification.port,
        remoteGit: remoteGit.port,
        ci: ci.port,
      };
    },
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
    expect(result.workerProfile).toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
  });

  it("uses the configured Target branch override when present", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            targetBranch: "develop",
            globalWorkerProfile: defaultWorkerProfile,
          },
        },
      }),
    );

    const result = await coordinator.preflight();

    expect(result.ok).toBe(true);
    expect(result.targetBranch).toBe("develop");
  });

  it("fails closed when there is no GitHub remote and offers corrective guidance", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
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
        defaultRoot: {
          environment: { isGhAuthenticated: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
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
        defaultRoot: {
          environment: {
            targetBranchExists: async (branch) => branch !== "main",
          },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "target-branch");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/main/);
    expect(check?.guidance).toMatch(/does not create branches/i);
    expect(check?.guidance).not.toMatch(
      /git init|create repository for you|I'll push|will push/i,
    );
  });

  it("fails closed when required Matt skills are missing and lists them", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          skillNames: ["to-spec", "implement"],
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
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
        defaultRoot: {
          preferences: {},
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "worker-profile");

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.guidance).toMatch(/Worker profile/i);
    expect(result.workerProfile).toBeUndefined();
  });

  it("surfaces the effective Worker profile source in preflight guidance", async () => {
    const rootProfile: WorkerProfile = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    const result = await coordinator.preflight();
    const check = result.checks.find((c) => c.id === "worker-profile");

    expect(result.ok).toBe(true);
    expect(check?.guidance).toMatch(/source workflow-root/);
    expect(result.workerProfile).toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
  });
});

describe("Workflow coordinator Worker profile precedence", () => {
  it("resolves global default when no root or snapshot override exists", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
  });

  it("prefers Workflow-root override over global default", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
    await expect(coordinator.getGlobalWorkerProfile()).resolves.toEqual(
      defaultWorkerProfile,
    );
    await expect(coordinator.getRootWorkerProfile()).resolves.toEqual(
      rootProfile,
    );
  });

  it("prefers workflow snapshot over Workflow-root and global", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const snapshotProfile: WorkerProfile = {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
            snapshotWorkerProfile: snapshotProfile,
          },
        },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: snapshotProfile,
      source: "workflow-snapshot",
    });
  });

  it("sets a global default Worker profile through the coordinator seam", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: { preferences: {} },
      }),
    );

    await expect(coordinator.getWorkerProfile()).resolves.toBeUndefined();

    await coordinator.setGlobalWorkerProfile(defaultWorkerProfile);

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
    await expect(coordinator.preflight()).resolves.toMatchObject({ ok: true });
  });

  it("sets a Workflow-root override without changing the global default", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await coordinator.setRootWorkerProfile(rootProfile);

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-root",
    });
    await expect(coordinator.getGlobalWorkerProfile()).resolves.toEqual(
      defaultWorkerProfile,
    );
  });

  it("clears the Workflow-root override so the global default becomes effective", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
        },
      }),
    );

    await coordinator.clearRootWorkerProfile();

    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: defaultWorkerProfile,
      source: "global",
    });
    await expect(coordinator.getRootWorkerProfile()).resolves.toBeUndefined();
  });

  it("rejects a Worker profile whose thinking level the model does not support", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(
      coordinator.setGlobalWorkerProfile({
        provider: "openai",
        modelId: "gpt-4o",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow(/not supported/i);
  });

  it("rejects a Worker profile whose model is not in the available catalog", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(
      coordinator.setGlobalWorkerProfile({
        provider: "anthropic",
        modelId: "does-not-exist",
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow(/available-model catalog/i);
  });

  it("lists authenticated available models and their supported thinking levels", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.listAvailableModels()).resolves.toEqual([
      reasoningModel,
      noReasoningModel,
    ]);
    await expect(
      coordinator.thinkingLevelsFor("anthropic", "claude-sonnet-4"),
    ).resolves.toEqual(["off", "minimal", "low", "medium", "high"]);
    await expect(
      coordinator.thinkingLevelsFor("openai", "gpt-4o"),
    ).resolves.toEqual(["off"]);
    await expect(
      coordinator.thinkingLevelsFor("missing", "model"),
    ).resolves.toEqual(["off"]);
  });

  it("keeps Worker profile configuration independent of Workflow home model selection", async () => {
    // Coordinator only writes preferences via the PreferencesPort. There is no
    // home-model port — configuring workers cannot change the session model.
    let homeModel = "workflow-home-model";
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: { preferences: {} },
      }),
    );

    await coordinator.setGlobalWorkerProfile(defaultWorkerProfile);
    await coordinator.setRootWorkerProfile({
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    });

    expect(homeModel).toBe("workflow-home-model");
    homeModel = "still-workflow-home-model";
    await expect(coordinator.getWorkerProfile()).resolves.toMatchObject({
      source: "workflow-root",
    });
    expect(homeModel).toBe("still-workflow-home-model");
  });
});

describe("Workflow coordinator Next actions", () => {
  it("returns no Next actions when preflight fails", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });

  it("offers Create spec when preflight passes and there is no Active workflow", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_SPEC_ACTION.id,
        label: CREATE_SPEC_ACTION.label,
        description: CREATE_SPEC_ACTION.description,
      },
    ]);
  });

  it("offers Create tickets after a published Create-spec workflow", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
        title: "Existing spec",
      },
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });
});

describe("Workflow coordinator Create-spec Planning stage", () => {
  it("runs Create-spec in Workflow home via the skills adapter and needs Stage confirmation", async () => {
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: { calls: skillsCalls },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-spec",
      draft: defaultSpecDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateSpec).toBe(1);
    // Planning stage must not publish silently.
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("does not launch Create-spec as an Implementation worker action surface", async () => {
    // Create-spec is only a Workflow-home Planning Next action, never a worker profile launch.
    const coordinator = createWorkflowCoordinator(createPorts());
    const actions = await coordinator.nextActions();

    expect(actions.map((a) => a.id)).toEqual([CREATE_SPEC_ACTION.id]);
    expect(actions.some((a) => /worker|implement/i.test(a.id))).toBe(false);
  });

  it("publishes only on Stage confirmation Publish and sets the Workflow ID from the issue number", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published).toEqual({
      status: "completed",
      stage: "create-spec",
      workflowId: 100,
    });
    expect(tracker.state.createIssueCalls).toBe(1);
    expect(tracker.state.writeManifestCalls).toBe(1);
    expect(tracker.state.issues[0]).toMatchObject({
      number: 100,
      title: defaultSpecDraft.title,
      body: defaultSpecDraft.body,
      labels: [SPEC_ISSUE_LABEL],
    });

    const manifest = tracker.state.manifests.get(100);
    expect(manifest).toEqual({
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: 100,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "spec-published",
      workerProfile: defaultWorkerProfile,
    });

    await expect(coordinator.getActiveWorkflow()).resolves.toEqual({
      workflowId: 100,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "spec-published",
      workerProfile: defaultWorkerProfile,
      title: defaultSpecDraft.title,
    });

    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });

  it("cancels Stage confirmation with no partial remote publication", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const cancelled = await coordinator.confirmStage("cancel");

    expect(cancelled).toEqual({
      status: "cancelled",
      stage: "create-spec",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
    expect(tracker.state.issues).toEqual([]);
    expect(tracker.state.manifests.size).toBe(0);
    await expect(coordinator.getActiveWorkflow()).resolves.toBeUndefined();
    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_SPEC_ACTION.id,
        label: CREATE_SPEC_ACTION.label,
        description: CREATE_SPEC_ACTION.description,
      },
    ]);
  });

  it("revises by re-invoking to-spec without remote publication", async () => {
    const revisedDraft: SpecDraft = {
      title: "Ship feature X (revised)",
      body: [
        "## Problem Statement",
        "Users still need feature X, but the first draft understated the edge cases.",
        "",
        "## Solution",
        "Revise the plan to cover edge cases while keeping the same seam.",
      ].join("\n"),
    };
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            calls: skillsCalls,
            createSpecOutcomes: [
              { ok: true, draft: defaultSpecDraft },
              { ok: true, draft: revisedDraft },
            ],
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    const revised = await coordinator.confirmStage("revise");

    expect(revised).toEqual({
      status: "needs-confirmation",
      stage: "create-spec",
      draft: revisedDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateSpec).toBe(2);
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("enters Compatibility recovery when to-spec omits a reviewable draft", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createSpecOutcomes: [
              { ok: false, reason: "Skill settled without a Stage result." },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result).toEqual({
      status: "compatibility-recovery",
      stage: "create-spec",
      reason: "Skill settled without a Stage result.",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when the draft is missing title or body", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createSpecOutcomes: [
              { ok: true, draft: { title: "  ", body: "body only" } },
            ],
          },
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("compatibility-recovery");
    if (result.status === "compatibility-recovery") {
      expect(result.reason).toMatch(/title|body|draft/i);
    }
  });

  it("fails closed when Create-spec is requested while preflight is incomplete", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/preflight/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Create-spec is requested while an Active workflow already exists", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 7,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
      },
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_SPEC_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/Active workflow/i);
    }
    // Existing remote state only — no additional publish attempt.
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Stage confirmation is given without a pending stage", async () => {
    const coordinator = createWorkflowCoordinator(createPorts());

    const result = await coordinator.confirmStage("publish");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/pending/i);
    }
  });

  it("snapshots the effective Worker profile into the Workflow manifest on publish", async () => {
    const rootProfile: WorkerProfile = {
      provider: "openai",
      modelId: "gpt-4o",
      thinkingLevel: "off",
    };
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: {
            globalWorkerProfile: defaultWorkerProfile,
            rootWorkerProfile: rootProfile,
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_SPEC_ACTION.id);
    await coordinator.confirmStage("publish");

    expect(tracker.state.manifests.get(100)?.workerProfile).toEqual(rootProfile);
    await expect(coordinator.getWorkerProfile()).resolves.toEqual({
      profile: rootProfile,
      source: "workflow-snapshot",
    });
  });
});

describe("Workflow coordinator root selection", () => {
  it("selects the nearest enclosing Git repository as the default Workflow root", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/mono/packages/app",
        topology: createTopology({ nearest: "/mono" }),
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root).toEqual({
      path: "/mono",
      kind: "nearest",
      status: "available",
    });
  });

  it("shares a single Workflow root for packages inside a monorepo", async () => {
    // Packages have no nested independent Git repos — only the enclosing root.
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/mono/packages/billing",
        topology: createTopology({ nearest: "/mono", nested: [] }),
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots).toEqual([
      {
        path: "/mono",
        kind: "nearest",
        status: "available",
      },
    ]);
  });

  it("discovers nested independent Git repositories as selectable Workflow roots", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/services/api", isSubmodule: false },
            { path: "/workspace/vendor/tool", isSubmodule: false },
          ],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/services/api": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/vendor/tool": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
        },
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots.map((r) => r.path)).toEqual([
      "/workspace",
      "/workspace/services/api",
      "/workspace/vendor/tool",
    ]);
    expect(roots[0]).toMatchObject({
      kind: "nearest",
      status: "available",
    });
    expect(roots[1]).toMatchObject({
      kind: "nested-independent",
      status: "available",
    });
    expect(roots[2]).toMatchObject({
      kind: "nested-independent",
      status: "available",
    });
  });

  it("does not treat Git submodules as supported Workflow roots", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/libs/shared", isSubmodule: true },
            { path: "/workspace/services/api", isSubmodule: false },
          ],
        }),
      }),
    );

    const roots = await coordinator.listRoots();

    expect(roots.map((r) => r.path)).toEqual([
      "/workspace",
      "/workspace/services/api",
    ]);
    expect(
      roots.some((r) => r.path === "/workspace/libs/shared"),
    ).toBe(false);
  });

  it("marks non-GitHub roots unavailable with an unsupported-tracker explanation", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/gitlab-only",
        topology: createTopology({ nearest: "/gitlab-only" }),
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: { globalWorkerProfile: defaultWorkerProfile },
        },
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root.status).toBe("unavailable");
    expect(root.unavailableReason).toBe(UNSUPPORTED_TRACKER_REASON);
    expect(root.unavailableReason).toMatch(/supported tracker/i);
    expect(root.unavailableReason).toMatch(/GitHub/i);
  });

  it("marks nested non-GitHub roots unavailable while leaving GitHub roots available", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [
            { path: "/workspace/legacy-gitlab", isSubmodule: false },
            { path: "/workspace/product", isSubmodule: false },
          ],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/legacy-gitlab": {
            environment: { hasGitHubRemote: async () => false },
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/product": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
        },
      }),
    );

    const roots = await coordinator.listRoots();
    const legacy = roots.find((r) => r.path === "/workspace/legacy-gitlab");
    const product = roots.find((r) => r.path === "/workspace/product");

    expect(legacy?.status).toBe("unavailable");
    expect(legacy?.unavailableReason).toBe(UNSUPPORTED_TRACKER_REASON);
    expect(product?.status).toBe("available");
    expect(product?.unavailableReason).toBeUndefined();
  });

  it("switches the selected Workflow root and runs preflight against it", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [{ path: "/workspace/services/api", isSubmodule: false }],
        }),
        roots: {
          "/workspace": {
            environment: { hasGitHubRemote: async () => false },
            preferences: { globalWorkerProfile: defaultWorkerProfile },
          },
          "/workspace/services/api": {
            preferences: {
              targetBranch: "develop",
              globalWorkerProfile: defaultWorkerProfile,
            },
          },
        },
      }),
    );

    await expect(coordinator.currentRoot()).resolves.toMatchObject({
      path: "/workspace",
      status: "unavailable",
    });
    await expect(coordinator.preflight()).resolves.toMatchObject({ ok: false });

    const selected = await coordinator.selectRoot("/workspace/services/api");
    expect(selected).toMatchObject({
      path: "/workspace/services/api",
      kind: "nested-independent",
      status: "available",
    });

    await expect(coordinator.currentRoot()).resolves.toMatchObject({
      path: "/workspace/services/api",
      status: "available",
    });

    const preflight = await coordinator.preflight();
    expect(preflight.ok).toBe(true);
    expect(preflight.targetBranch).toBe("develop");
  });

  it("rejects selecting a path that is not a discovered Workflow root", async () => {
    const coordinator = createWorkflowCoordinator(
      createPorts({
        topology: createTopology({ nearest: "/repo", nested: [] }),
      }),
    );

    await expect(coordinator.selectRoot("/not-a-root")).rejects.toThrow(
      /not a discovered Workflow root/i,
    );
  });

  it("marks the start path unavailable when no enclosing Git repository exists", async () => {
    const startPath = "/tmp/not-a-repo";
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath,
        topology: createTopology({ nearest: undefined, nested: [] }),
        defaultRoot: {
          environment: { hasGitHubRemote: async () => false },
          preferences: {},
        },
      }),
    );

    const root = await coordinator.currentRoot();

    expect(root.path).toBe(path.resolve(startPath));
    expect(root.kind).toBe("nearest");
    expect(root.status).toBe("unavailable");
    expect(root.unavailableReason).toBe(NO_GIT_REPOSITORY_REASON);
  });
});

describe("Workflow coordinator Create-tickets Planning stage", () => {
  function publishedSpecTracker(
    overrides: {
      workflowId?: number;
      title?: string;
    } = {},
  ) {
    return createTracker({
      active: {
        workflowId: overrides.workflowId ?? 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "spec-published",
        workerProfile: defaultWorkerProfile,
        title: overrides.title ?? "Existing spec",
      },
    });
  }

  it("runs Create-tickets in Workflow home via the skills adapter and needs Stage confirmation", async () => {
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = publishedSpecTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: { calls: skillsCalls },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-tickets",
      draft: defaultTicketsDraft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateTickets).toBe(1);
    // Planning stage must not publish silently.
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.addBlockedByCalls).toEqual([]);
    expect(tracker.state.addSubIssueCalls).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(0);
  });

  it("publishes tickets with blocking relationships and records them on the Workflow manifest", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42, title: "Existing spec" });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published.status).toBe("completed");
    if (published.status !== "completed") return;

    expect(published.stage).toBe("create-tickets");
    expect(published.workflowId).toBe(42);
    // Topological order: local 1 and 3 first (no blockers), then 2.
    // Stable relative order preserves draft order among ready tickets: 1 then 3 then 2.
    expect(published.tickets).toEqual([43, 44, 45]);
    expect(tracker.state.createIssueCalls).toBe(3);
    expect(tracker.state.addSubIssueCalls).toEqual([
      { parent: 42, child: 43 },
      { parent: 42, child: 44 },
      { parent: 42, child: 45 },
    ]);
    expect(tracker.state.addBlockedByCalls).toEqual([
      { issue: 45, blocker: 43 },
    ]);

    const ticketIssues = tracker.state.issues.filter((i) => i.number !== 42);
    expect(ticketIssues.map((i) => i.title)).toEqual([
      "Ship core path",
      "Ship parallel path",
      "Ship dependent path",
    ]);
    expect(ticketIssues.every((i) => i.labels.includes(TICKET_ISSUE_LABEL))).toBe(
      true,
    );

    const dependent = ticketIssues.find((i) => i.title === "Ship dependent path");
    expect(dependent?.body).toMatch(/#42 Existing spec/);
    expect(dependent?.body).toMatch(/#43 Ship core path/);
    expect(dependent?.blockedBy).toEqual([43]);

    const parallel = ticketIssues.find((i) => i.title === "Ship parallel path");
    expect(parallel?.body).toMatch(/None — can start immediately/);

    const manifest = tracker.state.manifests.get(42);
    expect(manifest).toEqual({
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: 42,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "tickets-published",
      workerProfile: defaultWorkerProfile,
      tickets: [43, 44, 45],
    });

    await expect(coordinator.getActiveWorkflow()).resolves.toMatchObject({
      workflowId: 42,
      stage: "tickets-published",
      tickets: [43, 44, 45],
    });
  });

  it("computes the ready frontier from GitHub ticket state after publish", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const published = await coordinator.confirmStage("publish");

    expect(published.status).toBe("completed");
    if (published.status !== "completed") return;

    // Ready: core (#43) and parallel (#44). Dependent (#45) blocked by open #43.
    expect(published.ticketProgress).toEqual({
      workflowId: 42,
      total: 3,
      open: 3,
      closed: 0,
      ready: [
        { number: 43, title: "Ship core path" },
        { number: 44, title: "Ship parallel path" },
      ],
      blocked: [
        {
          number: 45,
          title: "Ship dependent path",
          openBlockers: [43],
        },
      ],
      awaitingCi: [],
    });

    await expect(coordinator.getTicketProgress()).resolves.toEqual(
      published.ticketProgress,
    );

    // Closing a blocker expands the frontier.
    const core = tracker.state.issues.find((i) => i.number === 43);
    if (core) core.state = "CLOSED";

    const afterClose = await coordinator.getTicketProgress();
    expect(afterClose?.ready.map((t) => t.number).sort((a, b) => a - b)).toEqual([
      44, 45,
    ]);
    expect(afterClose?.closed).toBe(1);
    expect(afterClose?.open).toBe(2);
    expect(afterClose?.blocked).toEqual([]);
  });

  it("shows ticket-progress summary in Next actions after publish", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    await coordinator.confirmStage("publish");

    const actions = await coordinator.nextActions();
    // Ready tickets become Implement actions; progress summary remains available.
    expect(actions.map((a) => a.id)).toEqual([
      implementTicketActionId(43),
      implementTicketActionId(44),
      TICKET_PROGRESS_ACTION.id,
    ]);
    const progressAction = actions.find((a) => a.id === TICKET_PROGRESS_ACTION.id);
    expect(progressAction?.label).toMatch(/2 ready \/ 3 open \/ 0 closed/);
    expect(progressAction?.description).toMatch(/#43/);
    expect(progressAction?.description).toMatch(/#44/);

    const viewed = await coordinator.runNextAction(TICKET_PROGRESS_ACTION.id);
    expect(viewed.status).toBe("completed");
    if (viewed.status === "completed") {
      expect(viewed.ticketProgress?.ready).toHaveLength(2);
    }
  });

  it("cancels Stage confirmation with no partial remote publication", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const cancelled = await coordinator.confirmStage("cancel");

    expect(cancelled).toEqual({
      status: "cancelled",
      stage: "create-tickets",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
    expect(tracker.state.addBlockedByCalls).toEqual([]);
    expect(tracker.state.addSubIssueCalls).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(0);
    await expect(coordinator.getActiveWorkflow()).resolves.toMatchObject({
      stage: "spec-published",
    });
    await expect(coordinator.nextActions()).resolves.toEqual([
      {
        id: CREATE_TICKETS_ACTION.id,
        label: CREATE_TICKETS_ACTION.label,
        description: CREATE_TICKETS_ACTION.description,
      },
    ]);
  });

  it("revises by re-invoking to-tickets without remote publication", async () => {
    const revised: TicketsDraft = {
      tickets: [
        {
          localId: "a",
          title: "Only ticket",
          body: "Revised breakdown",
          blockedBy: [],
        },
      ],
    };
    const skillsCalls = { runCreateSpec: 0, runCreateTickets: 0 };
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            calls: skillsCalls,
            createTicketsOutcomes: [
              { ok: true, draft: defaultTicketsDraft },
              { ok: true, draft: revised },
            ],
          },
          tracker,
        },
      }),
    );

    await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);
    const result = await coordinator.confirmStage("revise");

    expect(result).toEqual({
      status: "needs-confirmation",
      stage: "create-tickets",
      draft: revised,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    });
    expect(skillsCalls.runCreateTickets).toBe(2);
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when to-tickets omits a reviewable breakdown", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createTicketsOutcomes: [
              { ok: false, reason: "Skill settled without a Stage result." },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result).toEqual({
      status: "compatibility-recovery",
      stage: "create-tickets",
      reason: "Skill settled without a Stage result.",
    });
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("enters Compatibility recovery when the breakdown has unknown blockers", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          skills: {
            createTicketsOutcomes: [
              {
                ok: true,
                draft: {
                  tickets: [
                    {
                      localId: "1",
                      title: "Broken",
                      body: "body",
                      blockedBy: ["missing"],
                    },
                  ],
                },
              },
            ],
          },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("compatibility-recovery");
    if (result.status === "compatibility-recovery") {
      expect(result.reason).toMatch(/unknown localId/i);
    }
  });

  it("fails closed when Create-tickets is requested without an Active workflow", async () => {
    const tracker = createTracker();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/Active workflow/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("fails closed when Create-tickets is requested after tickets are already published", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        tickets: [43, 44],
      },
      tickets: [
        { number: 43, title: "A", blockedBy: [] },
        { number: 44, title: "B", blockedBy: [43] },
      ],
    });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const result = await coordinator.runNextAction(CREATE_TICKETS_ACTION.id);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/tickets-published|unavailable/i);
    }
    expect(tracker.state.createIssueCalls).toBe(0);
  });

  it("does not treat Create-tickets as an Implementation worker action surface", async () => {
    const tracker = publishedSpecTracker({ workflowId: 42 });
    const coordinator = createWorkflowCoordinator(
      createPorts({
        defaultRoot: {
          preferences: { globalWorkerProfile: defaultWorkerProfile },
          tracker,
        },
      }),
    );

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([CREATE_TICKETS_ACTION.id]);
    expect(actions.some((a) => /worker|implement/i.test(a.id))).toBe(false);
  });
});

function ticketsPublishedFixture(
  options: {
    verification?: ReturnType<typeof createVerification>;
    remoteGit?: ReturnType<typeof createRemoteGit>;
    workspace?: ReturnType<typeof createWorkspace>;
    workers?: ReturnType<typeof createWorkers>;
    transcripts?: ReturnType<typeof createTranscripts>;
    skills?: SkillsFixture;
    ci?: ReturnType<typeof createCi>;
  } = {},
) {
  const tracker = createTracker({
    active: {
      workflowId: 42,
      targetBranch: DEFAULT_TARGET_BRANCH,
      stage: "tickets-published",
      workerProfile: defaultWorkerProfile,
      title: "Existing spec",
      tickets: [43, 44, 45],
    },
    tickets: [
      { number: 43, title: "Ship core path", blockedBy: [] },
      { number: 44, title: "Ship parallel path", blockedBy: [] },
      { number: 45, title: "Ship dependent path", blockedBy: [43] },
    ],
  });
  const workspace = options.workspace ?? createWorkspace("/repo");
  const workers = options.workers ?? createWorkers();
  const transcripts = options.transcripts ?? createTranscripts();
  const verification = options.verification ?? createVerification();
  const remoteGit = options.remoteGit ?? createRemoteGit();
  const ci = options.ci ?? createCi({ result: { status: "pending", summary: "CI pending" } });
  const skillsCalls = {
    runCreateSpec: 0,
    runCreateTickets: 0,
    prepareImplement: 0,
    prepareResolveConflicts: 0,
    ...(options.skills?.calls ?? {}),
  };
  const ports = createPorts({
    defaultRoot: {
      preferences: { globalWorkerProfile: defaultWorkerProfile },
      tracker,
      workspace,
      workers,
      transcripts,
      verification,
      remoteGit,
      ci,
      skills: {
        ...(options.skills ?? {}),
        calls: skillsCalls,
      },
    },
  });
  const coordinator = createWorkflowCoordinator(ports);
  return {
    coordinator,
    tracker,
    workspace,
    workers,
    transcripts,
    verification,
    remoteGit,
    skillsCalls,
  };
}

describe("Workflow coordinator single Implementation worker path", () => {
  it("offers Implement Next actions for each ready frontier ticket", async () => {
    const { coordinator } = ticketsPublishedFixture();

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([
      implementTicketActionId(43),
      implementTicketActionId(44),
      TICKET_PROGRESS_ACTION.id,
    ]);
    expect(actions[0]).toMatchObject({
      label: "Implement #43",
      description: expect.stringContaining("Ship core path"),
    });
    // Blocked ticket is not offered.
    expect(actions.some((a) => a.id === implementTicketActionId(45))).toBe(
      false,
    );
  });

  it("creates an Implementation workspace outside the Workflow root with agreed branch naming and launches a session-owned worker via /implement", async () => {
    const { coordinator, workspace, workers, skillsCalls, tracker } =
      ticketsPublishedFixture();
    const remoteWritesBefore = {
      create: tracker.state.createIssueCalls,
      manifest: tracker.state.writeManifestCalls,
      blockedBy: tracker.state.addBlockedByCalls.length,
    };

    const result = await coordinator.runNextAction(implementTicketActionId(43));

    expect(result).toEqual({
      status: "running",
      stage: "implement",
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
      workerId: "implement-42-43-r1",
      branchName: "matt-auto/42/ticket-43/r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
    });

    expect(workspace.state.creates).toEqual([
      {
        workflowId: 42,
        ticketNumber: 43,
        attempt: 1,
        baseRef: DEFAULT_TARGET_BRANCH,
        branchName: "matt-auto/42/ticket-43/r1",
        worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
      },
    ]);
    // Outside Workflow root /repo
    expect(workspace.state.creates[0]?.worktreePath.startsWith("/repo")).toBe(
      false,
    );

    expect(skillsCalls.prepareImplement).toBe(1);
    expect(workers.state.launches).toHaveLength(1);
    expect(workers.state.launches[0]).toMatchObject({
      workerId: "implement-42-43-r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
      branchName: "matt-auto/42/ticket-43/r1",
      skillCommand: "/implement",
      workerProfile: defaultWorkerProfile,
      ticketTitle: "Ship core path",
    });
    expect(workers.state.launches[0]?.prompt).toMatch(/\/implement/);
    expect(workers.state.launches[0]?.prompt).toMatch(/#43/);

    // Workers / launch path must not mutate GitHub.
    expect(tracker.state.createIssueCalls).toBe(remoteWritesBefore.create);
    expect(tracker.state.writeManifestCalls).toBe(remoteWritesBefore.manifest);
    expect(tracker.state.addBlockedByCalls).toHaveLength(
      remoteWritesBefore.blockedBy,
    );
  });

  it("shows running progress on the passive Workflow panel and retains the Worker transcript", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "progress",
      workerId: "implement-42-43-r1",
      message: "Running tests",
    });

    const panel = await coordinator.getPanelState();
    expect(panel?.workflowId).toBe(42);
    expect(panel?.workers).toEqual([
      {
        ticketNumber: 43,
        attempt: 1,
        status: "running",
        progress: "Running tests",
        branchName: "matt-auto/42/ticket-43/r1",
        workerId: "implement-42-43-r1",
        pid: 4242,
        processAlive: true,
        worktreePath: expect.stringContaining("ticket-43"),
        transcriptPath: expect.stringMatching(/ticket-43.*r1\.jsonl$/),
      },
    ]);
    expect(panel?.lines.some((l) => /Worker #43 r1: running/.test(l))).toBe(
      true,
    );
    expect(panel?.lines.some((l) => /Running tests/.test(l))).toBe(true);
    // Passive: panel is a summary, not an interactive action menu.
    expect(panel?.lines.join("\n")).not.toMatch(/\[x\]|click|button/i);

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript[0]).toMatchObject({ type: "worker-launch" });
    expect(transcript).toContainEqual({
      type: "progress",
      workerId: "implement-42-43-r1",
      message: "Running tests",
    });

    // No Next actions while the worker runs — panel owns progress.
    await expect(coordinator.nextActions()).resolves.toEqual([]);
  });

  it("receives Stage results over the Worker protocol and offers Implementation disposition", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();
    const writesBefore = tracker.state.writeManifestCalls;

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: {
        status: "completed",
        summary: "Core path implemented",
        localCommitSha: "abc123",
      },
    });
    await workers.emit("implement-42-43-r1", {
      type: "process-exit",
      workerId: "implement-42-43-r1",
      code: 0,
    });

    const panel = await coordinator.getPanelState();
    expect(panel?.workers[0]?.status).toBe("needs-disposition");

    // Still no remote writes from the worker path.
    expect(tracker.state.writeManifestCalls).toBe(writesBefore);
    expect(tracker.state.createIssueCalls).toBe(0);

    // Disposition is pending — offered as the only Next action.
    const actions = await coordinator.nextActions();
    expect(actions).toEqual([
      {
        id: `disposition:43`,
        label: "Disposition #43",
        description: "Core path implemented",
      },
    ]);

    const needsDisposition = await coordinator.runNextAction("disposition:43");
    expect(needsDisposition.status).toBe("needs-disposition");
    if (needsDisposition.status === "needs-disposition") {
      expect(needsDisposition.dispositionOptions).toEqual([
        "close",
        "leave-open",
        "investigate",
      ]);
    }

    const closed = await coordinator.confirmDisposition("close");
    expect(closed).toMatchObject({
      status: "pending-ci",
      stage: "ci-gate",
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
      integrated: true,
      ticketClosed: false,
      ciStatus: "pending",
      integrationBranch: "matt-auto/42/integration",
      integrationWorktreePath: "/matt-auto-workspaces/42/integration",
      localVerification: { ok: true, commands: ["npm test"] },
      pushedBranches: ["matt-auto/42/integration", "matt-auto/42/ticket-43/r1"],
      branchName: "matt-auto/42/ticket-43/r1",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r1",
    });

    // Close does not close the GitHub ticket (CI gate lands later).
    const ticket = tracker.state.issues.find((i) => i.number === 43);
    expect(ticket?.state).toBe("OPEN");
    // Coordinator updates the Workflow manifest after Local verification + push.
    expect(tracker.state.writeManifestCalls).toBe(writesBefore + 1);
  });

  it("supports Leave open and Investigate dispositions without remote writes", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(44));
    await workers.emit("implement-42-44-r1", {
      type: "stage-result",
      workerId: "implement-42-44-r1",
      outcome: { status: "completed", summary: "Parallel done" },
    });

    const leftOpen = await coordinator.confirmDisposition("leave-open");
    expect(leftOpen).toMatchObject({
      status: "completed",
      disposition: "leave-open",
      integrated: false,
      ticketNumber: 44,
    });
    expect(tracker.state.issues.find((i) => i.number === 44)?.state).toBe("OPEN");

    // Launch again (r2) for investigate path.
    await coordinator.runNextAction(implementTicketActionId(44));
    await workers.emit("implement-42-44-r2", {
      type: "stage-result",
      workerId: "implement-42-44-r2",
      outcome: { status: "completed" },
    });

    const investigated = await coordinator.confirmDisposition("investigate");
    expect(investigated).toMatchObject({
      status: "completed",
      disposition: "investigate",
      integrated: false,
      attempt: 2,
    });

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 44,
      attempt: 2,
    });
    expect(transcript).toContainEqual({
      type: "disposition",
      decision: "investigate",
    });

    expect(IMPLEMENTATION_DISPOSITION_OPTIONS).toEqual([
      "close",
      "leave-open",
      "investigate",
    ]);
  });

  it("enters Compatibility recovery when the worker exits without a Stage result or commits", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "process-exit",
      workerId: "implement-42-43-r1",
      code: 0,
    });

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(
      transcript.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "compatibility-recovery",
      ),
    ).toBe(true);

    // Cooldown: do not immediately re-offer the same ticket to the pipeline.
    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).not.toContain(implementTicketActionId(43));
    // Sibling ready tickets remain available.
    expect(actions.map((a) => a.id)).toContain(implementTicketActionId(44));
  });

  it("infers completion when worker exits 0 with local commits but no Stage result JSON", async () => {
    const workspace = createWorkspace("/repo");
    workspace.port.hasCommitsAhead = async () => ({
      ahead: true,
      headSha: "deadbeef",
      count: 1,
    });
    const { coordinator, workers } = ticketsPublishedFixture({
      workspace,
    });

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "process-exit",
      workerId: "implement-42-43-r1",
      code: 0,
    });

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toContain(dispositionActionId(43));

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(
      transcript.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "stage-result-inferred",
      ),
    ).toBe(true);
  });

  it("recovers pending disposition from transcript after a new coordinator session", async () => {
    const attempts = new Map<string, number>([["42:43", 5]]);
    const workspace = createWorkspace("/repo", { attempts });
    const transcripts = createTranscripts();
    await transcripts.port.append(
      { workflowId: 42, ticketNumber: 43, attempt: 5 },
      {
        type: "stage-result",
        workerId: "implement-42-43-r5",
        outcome: {
          status: "completed",
          summary: "docs landed",
          localCommitSha: "c7632f7b",
        },
      },
    );
    await transcripts.port.append(
      { workflowId: 42, ticketNumber: 43, attempt: 5 },
      { type: "process-exit", workerId: "implement-42-43-r5", code: 0 },
    );

    // Fresh coordinator — no in-memory pendingDisposition.
    const { coordinator } = ticketsPublishedFixture({
      workspace,
      transcripts,
    });

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([dispositionActionId(43)]);
    expect(actions.map((a) => a.id)).not.toContain(implementTicketActionId(43));
  });

  it("recovers Retry Integration after Close failed at Integration workspace create", async () => {
    const attempts = new Map<string, number>([["42:43", 7]]);
    const workspace = createWorkspace("/repo", { attempts });
    const transcripts = createTranscripts();
    const key = { workflowId: 42, ticketNumber: 43, attempt: 7 };
    await transcripts.port.append(key, {
      type: "stage-result",
      workerId: "implement-42-43-r7",
      outcome: { status: "completed", summary: "done" },
    });
    await transcripts.port.append(key, {
      type: "disposition",
      decision: "close",
    });
    await transcripts.port.append(key, {
      type: "integration-unit-start",
      ticketBranch: "matt-auto/42/ticket-43/r7",
    });
    await transcripts.port.append(key, {
      type: "integration-unit-failed",
      reason: "Failed to create Integration workspace: git ref conflict",
    });

    const { coordinator } = ticketsPublishedFixture({
      workspace,
      transcripts,
    });

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([integrateTicketActionId(43)]);
    expect(actions.map((a) => a.id)).not.toContain(implementTicketActionId(43));
  });

  it("aborts the session-owned worker cleanly and leaves GitHub state recoverable", async () => {
    const { coordinator, workers, tracker } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.abortWorkers();

    expect(workers.state.abortAllCount).toBe(1);
    expect(workers.state.aborts).toContain("implement-42-43-r1");

    // GitHub ticket still open and ready in progress summary.
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
    const progress = await coordinator.getTicketProgress();
    expect(progress?.ready.map((t) => t.number)).toContain(43);

    // Auto pipeline must not immediately re-select the aborted ticket.
    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).not.toContain(implementTicketActionId(43));

    // Explicit re-launch is still allowed (clears cooldown on successful launch).
    const relaunch = await coordinator.runNextAction(
      implementTicketActionId(43),
    );
    expect(relaunch).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
    });
  });

  it("exposes worker inspection handles on the panel and reconciles process-gone", async () => {
    const workers = createWorkers();
    let reportAlive = true;
    const baseGetRuntime = workers.port.getRuntime.bind(workers.port);
    workers.port.getRuntime = (workerId) => {
      const runtime = baseGetRuntime(workerId);
      if (!runtime) return undefined;
      return { ...runtime, alive: reportAlive };
    };

    const { coordinator, transcripts } = ticketsPublishedFixture({ workers });

    await coordinator.runNextAction(implementTicketActionId(43));
    const panelWhileAlive = await coordinator.getPanelState();
    const worker = panelWhileAlive?.workers[0];
    expect(worker).toMatchObject({
      ticketNumber: 43,
      attempt: 1,
      status: "running",
      workerId: "implement-42-43-r1",
      pid: 4242,
      processAlive: true,
      branchName: "matt-auto/42/ticket-43/r1",
    });
    expect(worker?.worktreePath).toContain("ticket-43");
    expect(worker?.transcriptPath).toContain("ticket-43");
    expect(worker?.transcriptPath).toMatch(/r1\.jsonl$/);

    // OS process vanished without a process-exit event.
    reportAlive = false;
    const panelAfterDeath = await coordinator.getPanelState();
    expect(
      panelAfterDeath?.workers.every((w) => w.status !== "running") ?? true,
    ).toBe(true);

    const events = await transcripts.port.read({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(events.some((e) => (e as { type?: string }).type === "process-gone")).toBe(
      true,
    );
  });

  it("aborts workers when switching Workflow root", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        tickets: [43],
      },
      tickets: [{ number: 43, title: "Only", blockedBy: [] }],
    });
    const workers = createWorkers();
    const coordinator = createWorkflowCoordinator(
      createPorts({
        startPath: "/workspace",
        topology: createTopology({
          nearest: "/workspace",
          nested: [{ path: "/workspace/services/api", isSubmodule: false }],
        }),
        roots: {
          "/workspace": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
            tracker,
            workers,
            workspace: createWorkspace("/workspace"),
            transcripts: createTranscripts(),
          },
          "/workspace/services/api": {
            preferences: { globalWorkerProfile: defaultWorkerProfile },
            workspace: createWorkspace("/workspace/services/api"),
            workers: createWorkers(),
            transcripts: createTranscripts(),
          },
        },
      }),
    );

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.selectRoot("/workspace/services/api");

    expect(workers.state.abortAllCount).toBe(1);
  });

  it("fails closed when launching a ticket that is not on the ready frontier", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    const result = await coordinator.runNextAction(implementTicketActionId(45));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/ready frontier/i);
    }
    expect(workers.state.launches).toHaveLength(0);
  });

  it("rejects a second concurrent launch on the single-worker path", async () => {
    const { coordinator } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    const second = await coordinator.runNextAction(implementTicketActionId(44));

    expect(second.status).toBe("failed");
    if (second.status === "failed") {
      expect(second.reason).toMatch(/already running/i);
    }
  });

  it("numbers rework attempts without reusing a completed workspace identity", async () => {
    const { coordinator, workers, workspace } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: { status: "completed" },
    });
    await coordinator.confirmDisposition("leave-open");

    const second = await coordinator.runNextAction(implementTicketActionId(43));
    expect(second).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r2",
    });
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1, 2]);
  });
});

describe("Workflow coordinator Integration unit", () => {
  async function completeWorker(
    coordinator: ReturnType<typeof createWorkflowCoordinator>,
    workers: ReturnType<typeof createWorkers>,
    ticketNumber: number,
    attempt = 1,
  ) {
    await coordinator.runNextAction(implementTicketActionId(ticketNumber));
    const workerId = `implement-42-${ticketNumber}-r${attempt}`;
    await workers.emit(workerId, {
      type: "stage-result",
      workerId,
      outcome: { status: "completed", summary: `Done #${ticketNumber}` },
    });
  }

  it("Close starts a serialized Integration unit in a dedicated Integration workspace", async () => {
    const { coordinator, workers, workspace, remoteGit, tracker } =
      ticketsPublishedFixture();

    await completeWorker(coordinator, workers, 43);
    const result = await coordinator.confirmDisposition("close");

    expect(result.status).toBe("pending-ci");
    if (result.status === "pending-ci") {
      expect(result.stage).toBe("ci-gate");
      expect(result.integrated).toBe(true);
      expect(result.ticketClosed).toBe(false);
      expect(result.integrationBranch).toBe("matt-auto/42/integration");
      expect(result.integrationWorktreePath).toBe(
        "/matt-auto-workspaces/42/integration",
      );
    }

    expect(workspace.state.integrationEnsures).toEqual([
      {
        workflowId: 42,
        baseRef: DEFAULT_TARGET_BRANCH,
        branchName: "matt-auto/42/integration",
        worktreePath: "/matt-auto-workspaces/42/integration",
      },
    ]);
    // Outside Workflow root
    expect(
      workspace.state.integrationEnsures[0]?.worktreePath.startsWith("/repo"),
    ).toBe(false);

    expect(workspace.state.merges).toEqual([
      { workflowId: 42, ticketBranch: "matt-auto/42/ticket-43/r1" },
    ]);
    expect(remoteGit.state.pushes).toEqual([
      "matt-auto/42/integration",
      "matt-auto/42/ticket-43/r1",
    ]);

    const manifest = tracker.state.manifests.get(42);
    expect(manifest?.integrationBranch).toBe("matt-auto/42/integration");
    expect(manifest?.integratedTickets).toEqual([
      {
        number: 43,
        attempt: 1,
        branchName: "matt-auto/42/ticket-43/r1",
      },
    ]);
    // Ticket remains open (CI gate later).
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
  });

  it("runs Local verification before push and fails closed with no remote advancement", async () => {
    const verification = createVerification({
      result: {
        ok: false,
        reason: "npm test failed",
        commands: ["npm test"],
      },
    });
    const { coordinator, workers, remoteGit, tracker, workspace } =
      ticketsPublishedFixture({ verification });
    const manifestBefore = tracker.state.writeManifestCalls;

    await completeWorker(coordinator, workers, 43);
    const result = await coordinator.confirmDisposition("close");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.stage).toBe("integrate");
      expect(result.reason).toMatch(/Local verification failed/i);
    }

    // Merge happened locally; verification ran; no push / no manifest write.
    expect(workspace.state.merges).toHaveLength(1);
    expect(verification.state.calls).toEqual([
      "/matt-auto-workspaces/42/integration",
    ]);
    expect(remoteGit.state.pushes).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(manifestBefore);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");

    // Fail-closed retry is the only Next action.
    const actions = await coordinator.nextActions();
    expect(actions).toEqual([
      {
        id: integrateTicketActionId(43),
        label: "Retry Integration #43",
        description: expect.stringMatching(/Local verification failed/i),
      },
    ]);
  });

  it("retries a failed Integration unit through the coordinator seam", async () => {
    const verification = createVerification({
      result: {
        ok: false,
        reason: "npm test failed",
        commands: ["npm test"],
      },
    });
    const { coordinator, workers, remoteGit, tracker } =
      ticketsPublishedFixture({ verification });

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");
    expect(remoteGit.state.pushes).toEqual([]);

    // Fix verification and retry.
    verification.state.result = { ok: true, commands: ["npm test"] };
    const retried = await coordinator.runNextAction(integrateTicketActionId(43));
    expect(retried).toMatchObject({
      status: "pending-ci",
      stage: "ci-gate",
      integrated: true,
      ticketNumber: 43,
      ticketClosed: false,
    });
    expect(remoteGit.state.pushes).toEqual([
      "matt-auto/42/integration",
      "matt-auto/42/ticket-43/r1",
    ]);
    expect(tracker.state.manifests.get(42)?.integratedTickets).toEqual([
      {
        number: 43,
        attempt: 1,
        branchName: "matt-auto/42/ticket-43/r1",
      },
    ]);
  });

  it("branches dependent Implementation workspaces from the Integration branch after success", async () => {
    const { coordinator, workers, workspace } = ticketsPublishedFixture();

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    // Ticket 45 was blocked by 43; still blocked until ticket close/CI.
    // Launch another ready ticket (#44) — should base on Integration branch.
    await coordinator.runNextAction(implementTicketActionId(44));
    const launch = workspace.state.creates.find((c) => c.ticketNumber === 44);
    expect(launch?.baseRef).toBe("matt-auto/42/integration");
  });

  it("processes Integration units one completed ticket at a time", async () => {
    // After one unit fails closed, another Close cannot start until resolved.
    const verification = createVerification({
      result: {
        ok: false,
        reason: "broken",
        commands: ["npm test"],
      },
    });
    const { coordinator, workers } = ticketsPublishedFixture({ verification });

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    // While pending integration for 43, launching another implement is blocked
    // only by pending integration Next action surface — retry is sole action.
    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([integrateTicketActionId(43)]);
    expect(actions.some((a) => a.id === implementTicketActionId(44))).toBe(
      false,
    );
  });

  it("records Integration unit transitions in the Worker transcript", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "integration-unit-start" }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "local-verification" }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "integration-unit-completed" }),
    );
  });
});

describe("Workflow coordinator Conflict resolution worker", () => {
  async function completeWorker(
    coordinator: ReturnType<typeof createWorkflowCoordinator>,
    workers: ReturnType<typeof createWorkers>,
    ticketNumber: number,
    attempt = 1,
  ) {
    await coordinator.runNextAction(implementTicketActionId(ticketNumber));
    const workerId = `implement-42-${ticketNumber}-r${attempt}`;
    await workers.emit(workerId, {
      type: "stage-result",
      workerId,
      outcome: { status: "completed", summary: `Done #${ticketNumber}` },
    });
  }

  function conflictWorkspace() {
    return createWorkspace("/repo", {
      mergeResult: {
        ok: false,
        reason: "conflict",
        message: "CONFLICT (content): merge conflict in src/app.ts",
      },
    });
  }

  it("preserves the in-progress merge and launches a Conflict resolution worker in the Integration workspace", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit, tracker, skillsCalls } =
      ticketsPublishedFixture({ workspace });
    const manifestBefore = tracker.state.writeManifestCalls;

    await completeWorker(coordinator, workers, 43);
    const result = await coordinator.confirmDisposition("close");

    expect(result).toMatchObject({
      status: "running",
      stage: "integrate",
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
      workerId: "conflict-42-43-r1",
      integrationBranch: "matt-auto/42/integration",
      integrationWorktreePath: "/matt-auto-workspaces/42/integration",
      conflictResolution: true,
    });

    // Uses the installed resolving-merge-conflicts skill — no invented skill.
    expect(skillsCalls.prepareResolveConflicts).toBe(1);
    expect(workers.state.launches).toEqual([
      expect.objectContaining({
        workerId: "implement-42-43-r1",
        skillCommand: "/implement",
      }),
      expect.objectContaining({
        workerId: "conflict-42-43-r1",
        worktreePath: "/matt-auto-workspaces/42/integration",
        branchName: "matt-auto/42/integration",
        skillCommand: "/resolving-merge-conflicts",
        prompt: expect.stringContaining("/resolving-merge-conflicts"),
      }),
    ]);
    expect(workers.state.launches[1]?.prompt).not.toMatch(
      /\/resolve-conflicts|\/conflict-resolution/i,
    );

    // No remote advancement while the merge is still unresolved.
    expect(remoteGit.state.pushes).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(manifestBefore);

    // Passive panel shows Conflict resolution; Next actions empty while it runs.
    const panel = await coordinator.getPanelState();
    expect(panel?.integration).toMatchObject({
      ticketNumber: 43,
      status: "conflict-resolution",
      branchName: "matt-auto/42/integration",
    });
    expect(
      panel?.lines.some((l) => /Conflict resolution #43/.test(l)),
    ).toBe(true);
    expect(await coordinator.nextActions()).toEqual([]);
  });

  it("on successful resolution resumes Local verification and the coordinator completion path", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit, tracker, verification } =
      ticketsPublishedFixture({ workspace });

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    // Conflict resolution worker finishes the preserved merge.
    await workers.emit("conflict-42-43-r1", {
      type: "stage-result",
      workerId: "conflict-42-43-r1",
      outcome: { status: "completed", summary: "Conflicts resolved" },
    });

    // Local verification + coordinator remote writes resume without re-merge.
    expect(workspace.state.merges).toHaveLength(1);
    expect(verification.state.calls).toEqual([
      "/matt-auto-workspaces/42/integration",
    ]);
    expect(remoteGit.state.pushes).toEqual([
      "matt-auto/42/integration",
      "matt-auto/42/ticket-43/r1",
    ]);
    expect(tracker.state.manifests.get(42)?.integratedTickets).toEqual([
      {
        number: 43,
        attempt: 1,
        branchName: "matt-auto/42/ticket-43/r1",
      },
    ]);

    const panel = await coordinator.getPanelState();
    expect(panel?.integration).toBeUndefined();

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "conflict-resolution-launch" }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "stage-result",
        workerId: "conflict-42-43-r1",
      }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "local-verification" }),
    );
    expect(transcript).toContainEqual(
      expect.objectContaining({ type: "integration-unit-completed" }),
    );
  });

  it("on Conflict resolution failure enters recovery without guessing merges or remote advancement", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit, tracker } =
      ticketsPublishedFixture({ workspace });
    const manifestBefore = tracker.state.writeManifestCalls;

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    await workers.emit("conflict-42-43-r1", {
      type: "stage-result",
      workerId: "conflict-42-43-r1",
      outcome: {
        status: "failed",
        reason: "Could not preserve both intents in src/app.ts",
      },
    });

    expect(remoteGit.state.pushes).toEqual([]);
    expect(tracker.state.writeManifestCalls).toBe(manifestBefore);
    // Did not re-merge or invent a resolution.
    expect(workspace.state.merges).toHaveLength(1);

    const actions = await coordinator.nextActions();
    expect(actions).toEqual([
      {
        id: integrateTicketActionId(43),
        label: "Retry Integration #43",
        description: expect.stringMatching(/Conflict resolution failed/i),
      },
    ]);
  });

  it("retries Conflict resolution through the coordinator seam without re-merging", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit, skillsCalls } =
      ticketsPublishedFixture({ workspace });

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");
    await workers.emit("conflict-42-43-r1", {
      type: "stage-result",
      workerId: "conflict-42-43-r1",
      outcome: { status: "failed", reason: "still conflicted" },
    });

    const retried = await coordinator.runNextAction(
      integrateTicketActionId(43),
    );
    expect(retried).toMatchObject({
      status: "running",
      stage: "integrate",
      conflictResolution: true,
      workerId: "conflict-42-43-r1",
    });
    // In-progress merge preserved: no second merge attempt.
    expect(workspace.state.merges).toHaveLength(1);
    expect(skillsCalls.prepareResolveConflicts).toBe(2);

    await workers.emit("conflict-42-43-r1", {
      type: "stage-result",
      workerId: "conflict-42-43-r1",
      outcome: { status: "completed", summary: "Resolved on retry" },
    });

    expect(remoteGit.state.pushes).toEqual([
      "matt-auto/42/integration",
      "matt-auto/42/ticket-43/r1",
    ]);
  });

  it("enters Compatibility recovery when the Conflict resolution worker omits a Stage result", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit } = ticketsPublishedFixture({
      workspace,
    });

    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    await workers.emit("conflict-42-43-r1", {
      type: "process-exit",
      workerId: "conflict-42-43-r1",
      code: 1,
    });

    expect(remoteGit.state.pushes).toEqual([]);

    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript).toContainEqual(
      expect.objectContaining({
        type: "compatibility-recovery",
        reason: expect.stringMatching(/without a Stage result/i),
      }),
    );

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([integrateTicketActionId(43)]);
    expect(actions[0]?.description).toMatch(/Compatibility recovery/i);
  });

  it("enters Compatibility recovery when resolving-merge-conflicts is missing", async () => {
    const workspace = conflictWorkspace();
    const { coordinator, workers, remoteGit, skillsCalls } =
      ticketsPublishedFixture({
        workspace,
        skills: {
          prepareResolveConflictsOutcome: {
            ok: false,
            reason:
              "Installed skill resolving-merge-conflicts is missing. Install it into a Pi skill location and retry Conflict resolution.",
          },
        },
      });

    await completeWorker(coordinator, workers, 43);
    const result = await coordinator.confirmDisposition("close");

    expect(result).toMatchObject({
      status: "compatibility-recovery",
      stage: "integrate",
      ticketNumber: 43,
    });
    if (result.status === "compatibility-recovery") {
      expect(result.reason).toMatch(/resolving-merge-conflicts/i);
    }
    expect(skillsCalls.prepareResolveConflicts).toBe(1);
    expect(
      workers.state.launches.filter((l) =>
        l.workerId.startsWith("conflict-"),
      ),
    ).toHaveLength(0);
    expect(remoteGit.state.pushes).toEqual([]);
  });
});

describe("Workflow coordinator on-demand CI gate", () => {
  async function completeWorker(
    coordinator: ReturnType<typeof createWorkflowCoordinator>,
    workers: ReturnType<typeof createWorkers>,
    ticketNumber: number,
    attempt = 1,
  ) {
    await coordinator.runNextAction(implementTicketActionId(ticketNumber));
    const workerId = `implement-42-${ticketNumber}-r${attempt}`;
    await workers.emit(workerId, {
      type: "stage-result",
      workerId,
      outcome: { status: "completed", summary: `Done #${ticketNumber}` },
    });
  }

  async function integrateWithCi(ciResult: CiCheckResult) {
    const ci = createCi({ result: ciResult });
    const fixture = ticketsPublishedFixture({ ci });
    await completeWorker(fixture.coordinator, fixture.workers, 43);
    const result = await fixture.coordinator.confirmDisposition("close");
    return { ...fixture, result, ci };
  }

  it("returns control immediately when CI is pending after Integration push", async () => {
    const { result, tracker, ci } = await integrateWithCi({
      status: "pending",
      summary: "Actions still running",
      url: "https://example.test/run/1",
    });
    expect(result).toMatchObject({
      status: "pending-ci",
      stage: "ci-gate",
      ticketNumber: 43,
      integrated: true,
      ticketClosed: false,
      ciStatus: "pending",
    });
    expect(ci.state.checks).toEqual(["matt-auto/42/integration"]);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
    expect(tracker.state.closeIssueCalls).toEqual([]);
  });

  it("offers Check CI as a Next action for open integrated tickets (on-demand)", async () => {
    const { coordinator } = await integrateWithCi({ status: "pending" });
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(checkCiActionId(43));
    expect(ids).not.toContain(implementTicketActionId(43));
    expect(ids).toContain(implementTicketActionId(44));
  });

  it("performs an on-demand CI recheck via Check CI without background polling", async () => {
    const ci = createCi({ result: { status: "pending", summary: "still pending" } });
    const { coordinator, workers } = ticketsPublishedFixture({ ci });
    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");
    expect(ci.state.checks).toHaveLength(1);
    const recheck = await coordinator.runNextAction(checkCiActionId(43));
    expect(recheck).toMatchObject({ status: "pending-ci", stage: "ci-gate", ticketClosed: false });
    expect(ci.state.checks).toEqual(["matt-auto/42/integration", "matt-auto/42/integration"]);
  });

  it("closes the ticket only when CI is green", async () => {
    const { result, tracker } = await integrateWithCi({
      status: "success",
      summary: "All checks passed",
    });
    expect(result).toMatchObject({
      status: "completed",
      stage: "ci-gate",
      ticketNumber: 43,
      ticketClosed: true,
      ciStatus: "success",
    });
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("CLOSED");
    expect(tracker.state.closeIssueCalls).toEqual([43]);
  });

  it("unblocks dependents in frontier calculation after CI green closes a ticket", async () => {
    const { coordinator } = await integrateWithCi({ status: "success" });
    const progress = await coordinator.getTicketProgress();
    expect(progress?.awaitingCi.map((t) => t.number)).toEqual([]);
    expect(progress?.ready.map((t) => t.number).sort((a, b) => a - b)).toEqual([44, 45]);
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(implementTicketActionId(45));
    expect(ids).not.toContain(checkCiActionId(43));
  });

  it("does not close the ticket while CI is pending or red", async () => {
    const pending = await integrateWithCi({ status: "pending" });
    expect(pending.tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
    const failed = await integrateWithCi({
      status: "failure",
      summary: "npm test failed",
      url: "https://example.test/run/bad",
    });
    expect(failed.result).toMatchObject({
      status: "needs-ci-recovery",
      stage: "ci-gate",
      ticketClosed: false,
      ciStatus: "failure",
    });
    expect(failed.tracker.state.closeIssueCalls).toEqual([]);
  });

  it("offers inspect / retry / leave-open recovery actions when CI is red", async () => {
    const { coordinator } = await integrateWithCi({
      status: "failure",
      summary: "lint failed",
      url: "https://example.test/run/2",
    });
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(ciRecoveryActionId(43, "inspect"));
    expect(ids).toContain(ciRecoveryActionId(43, "retry"));
    expect(ids).toContain(ciRecoveryActionId(43, "leave-open"));
    expect(ids).not.toContain(checkCiActionId(43));
  });

  it("inspect / leave-open / retry recovery path", async () => {
    const ci = createCi({
      result: { status: "failure", summary: "build failed", url: "https://example.test/run/3" },
    });
    const { coordinator, workers, tracker, remoteGit } = ticketsPublishedFixture({ ci });
    await completeWorker(coordinator, workers, 43);
    await coordinator.confirmDisposition("close");

    const inspected = await coordinator.runNextAction(ciRecoveryActionId(43, "inspect"));
    expect(inspected).toMatchObject({
      status: "completed",
      stage: "ci-gate",
      ticketClosed: false,
      ciStatus: "failure",
      ciUrl: "https://example.test/run/3",
    });

    const left = await coordinator.runNextAction(ciRecoveryActionId(43, "leave-open"));
    expect(left).toMatchObject({ disposition: "leave-open", ticketClosed: false });
    expect((await coordinator.nextActions()).map((a) => a.id)).toContain(checkCiActionId(43));

    ci.state.result = { status: "failure", summary: "still red" };
    await coordinator.runNextAction(checkCiActionId(43));
    const pushesBefore = remoteGit.state.pushes.length;
    ci.state.result = { status: "success", summary: "fixed" };
    const retried = await coordinator.runNextAction(ciRecoveryActionId(43, "retry"));
    expect(retried).toMatchObject({ status: "completed", ticketClosed: true, ciStatus: "success" });
    expect(remoteGit.state.pushes.slice(pushesBefore)).toEqual(["matt-auto/42/integration"]);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("CLOSED");
  });

  it("records CI gate transitions in the Worker transcript", async () => {
    const { coordinator } = await integrateWithCi({ status: "success", summary: "green" });
    const transcript = await coordinator.getWorkerTranscript({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(transcript).toContainEqual(expect.objectContaining({ type: "ci-check", status: "success" }));
    expect(transcript).toContainEqual(expect.objectContaining({ type: "ticket-closed", ticketNumber: 43 }));
  });
});

describe("Workflow coordinator Workflow PR, paired cleanup, rework, and follow-up", () => {
  async function completeWorker(
    coordinator: ReturnType<typeof createWorkflowCoordinator>,
    workers: ReturnType<typeof createWorkers>,
    ticketNumber: number,
    attempt = 1,
  ) {
    await coordinator.runNextAction(implementTicketActionId(ticketNumber));
    const workerId = `implement-42-${ticketNumber}-r${attempt}`;
    await workers.emit(workerId, {
      type: "stage-result",
      workerId,
      outcome: { status: "completed", summary: `Done #${ticketNumber}` },
    });
  }

  async function integrateAndClose(
    coordinator: ReturnType<typeof createWorkflowCoordinator>,
    workers: ReturnType<typeof createWorkers>,
    ticketNumber: number,
    attempt = 1,
  ) {
    await completeWorker(coordinator, workers, ticketNumber, attempt);
    const result = await coordinator.confirmDisposition("close");
    expect(result).toMatchObject({
      status: "completed",
      stage: "ci-gate",
      ticketClosed: true,
      ticketNumber,
    });
  }

  function allCompleteFixture() {
    const ci = createCi({ result: { status: "success", summary: "green" } });
    const fixture = ticketsPublishedFixture({ ci });
    return { ...fixture, ci };
  }

  async function driveAllTicketsComplete() {
    const fixture = allCompleteFixture();
    const { coordinator, workers } = fixture;
    // 43 unblocks 45; 44 is independent.
    await integrateAndClose(coordinator, workers, 43);
    await integrateAndClose(coordinator, workers, 44);
    await integrateAndClose(coordinator, workers, 45);
    return fixture;
  }

  it("offers a single Workflow PR only after all tickets are integrated and CI-complete", async () => {
    const partial = allCompleteFixture();
    await integrateAndClose(partial.coordinator, partial.workers, 43);
    const partialIds = (await partial.coordinator.nextActions()).map((a) => a.id);
    expect(partialIds).not.toContain(OPEN_WORKFLOW_PR_ACTION.id);
    expect(partialIds).toContain(implementTicketActionId(44));

    const { coordinator } = await driveAllTicketsComplete();
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids[0]).toBe(OPEN_WORKFLOW_PR_ACTION.id);
    expect(ids).not.toContain(implementTicketActionId(43));
    expect(ids).not.toContain(implementTicketActionId(44));
    expect(ids).not.toContain(implementTicketActionId(45));
  });

  it("opens one Workflow PR from the Integration branch to the configured Target branch", async () => {
    const { coordinator, tracker } = await driveAllTicketsComplete();
    const opened = await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    expect(opened).toMatchObject({
      status: "completed",
      stage: "workflow-pr",
      workflowId: 42,
      workflowPrNumber: 500,
      targetBranch: DEFAULT_TARGET_BRANCH,
      integrationBranch: "matt-auto/42/integration",
    });
    expect(tracker.state.createPrCalls).toEqual([
      {
        head: "matt-auto/42/integration",
        base: DEFAULT_TARGET_BRANCH,
        title: expect.stringContaining("Workflow #42"),
      },
    ]);
    const manifest = tracker.state.manifests.get(42);
    expect(manifest?.stage).toBe("pr-opened");
    expect(manifest?.workflowPr).toMatchObject({
      number: 500,
      headBranch: "matt-auto/42/integration",
      baseBranch: DEFAULT_TARGET_BRANCH,
    });

    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids[0]).toBe(MERGE_WORKFLOW_PR_ACTION.id);
    expect(ids).not.toContain(OPEN_WORKFLOW_PR_ACTION.id);
  });

  it("targets a configured non-main Target branch on the Workflow PR", async () => {
    const ci = createCi({ result: { status: "success", summary: "green" } });
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: "develop",
        stage: "tickets-published",
        workerProfile: defaultWorkerProfile,
        title: "Develop workflow",
        tickets: [43, 44, 45],
      },
      tickets: [
        { number: 43, title: "Ship core path", blockedBy: [] },
        { number: 44, title: "Ship parallel path", blockedBy: [] },
        { number: 45, title: "Ship dependent path", blockedBy: [43] },
      ],
    });
    const workspace = createWorkspace("/repo");
    const workers = createWorkers();
    const remoteGit = createRemoteGit();
    const ports = createPorts({
      defaultRoot: {
        preferences: {
          targetBranch: "develop",
          globalWorkerProfile: defaultWorkerProfile,
        },
        tracker,
        workspace,
        workers,
        remoteGit,
        ci,
      },
    });
    const coordinator = createWorkflowCoordinator(ports);
    await integrateAndClose(coordinator, workers, 43);
    await integrateAndClose(coordinator, workers, 44);
    await integrateAndClose(coordinator, workers, 45);

    const opened = await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    expect(opened).toMatchObject({
      status: "completed",
      targetBranch: "develop",
    });
    expect(tracker.state.createPrCalls[0]?.base).toBe("develop");
    expect(tracker.state.manifests.get(42)?.workflowPr?.baseBranch).toBe("develop");
  });

  it("merges the Workflow PR as a Matt Auto Next action", async () => {
    const { coordinator, tracker } = await driveAllTicketsComplete();
    await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    const merged = await coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);
    expect(merged).toMatchObject({
      status: "completed",
      stage: "workflow-pr",
      workflowId: 42,
      workflowPrNumber: 500,
    });
    expect(tracker.state.mergePrCalls).toEqual([500]);
    expect(tracker.state.pullRequests[0]?.merged).toBe(true);
    expect(tracker.state.manifests.get(42)?.stage).toBe("merged");

    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toEqual([CLEANUP_WORKFLOW_ACTION.id]);
  });

  it("pairs local and remote matt-auto cleanup after merge and closes the parent Workflow spec", async () => {
    const fixture = await driveAllTicketsComplete();
    const { coordinator, tracker, workspace, remoteGit, transcripts } = fixture;
    await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    await coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);

    const cleaned = await coordinator.runNextAction(CLEANUP_WORKFLOW_ACTION.id);
    expect(cleaned).toMatchObject({
      status: "completed",
      stage: "cleanup",
      workflowId: 42,
      cleanedLocal: true,
      cleanedRemote: true,
      parentSpecClosed: true,
    });
    expect(workspace.state.cleanupCalls).toEqual([42]);
    expect(remoteGit.state.deleted).toHaveLength(1);
    const deleted = remoteGit.state.deleted[0] ?? [];
    expect(deleted).toContain("matt-auto/42/integration");
    expect(deleted).toContain("matt-auto/42/ticket-43/r1");
    expect(deleted).toContain("matt-auto/42/ticket-44/r1");
    expect(deleted).toContain("matt-auto/42/ticket-45/r1");
    expect(transcripts.cleanupCalls).toEqual([42]);

    // Parent Workflow spec closed with a completion comment; PR/manifest retained.
    expect(tracker.state.closeIssueCalls).toContain(42);
    expect(
      tracker.state.closeIssueComments.some(
        (c) =>
          c.number === 42 &&
          c.comment.includes("git pull") &&
          c.comment.includes("/reload"),
      ),
    ).toBe(true);
    expect(tracker.state.issues.find((i) => i.number === 42)?.state).toBe(
      "CLOSED",
    );
    expect(tracker.state.pullRequests).toHaveLength(1);
    expect(tracker.state.manifests.get(42)?.stage).toBe("completed");
    expect(tracker.state.manifests.get(42)?.workflowPr?.number).toBe(500);

    // No longer Active after cleanup.
    await expect(coordinator.getActiveWorkflow()).resolves.toBeUndefined();
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(CREATE_SPEC_ACTION.id);
    expect(ids).toContain(START_FOLLOW_UP_ACTION.id);
  });

  it("soft-fails parent close after artifact cleanup without failing Cleanup", async () => {
    const fixture = await driveAllTicketsComplete();
    const { coordinator, tracker } = fixture;
    await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    await coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);

    const originalClose = tracker.port.closeIssue.bind(tracker.port);
    tracker.port.closeIssue = async () => {
      throw new Error("gh API rate limited");
    };

    const cleaned = await coordinator.runNextAction(CLEANUP_WORKFLOW_ACTION.id);
    expect(cleaned).toMatchObject({
      status: "completed",
      stage: "cleanup",
      workflowId: 42,
      cleanedLocal: true,
      cleanedRemote: true,
      parentSpecClosed: false,
      parentSpecCloseWarning: "gh API rate limited",
    });

    tracker.port.closeIssue = originalClose;
  });

  it("creates a fresh numbered Rework attempt workspace for a closed ticket before merge", async () => {
    const { coordinator, workers, tracker, workspace } = await driveAllTicketsComplete();
    // Pre-merge: all tickets closed; rework reopens and numbers a new attempt.
    const idsBefore = (await coordinator.nextActions()).map((a) => a.id);
    expect(idsBefore).toContain(reworkTicketActionId(43));
    expect(idsBefore).toContain(OPEN_WORKFLOW_PR_ACTION.id);

    const reworked = await coordinator.runNextAction(reworkTicketActionId(43));
    expect(reworked).toMatchObject({
      status: "running",
      stage: "implement",
      ticketNumber: 43,
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
    });
    expect(tracker.state.reopenIssueCalls).toEqual([43]);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");
    expect(
      tracker.state.manifests.get(42)?.integratedTickets?.map((t) => t.number),
    ).toEqual([44, 45]);
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1, 1, 1, 2]);

    // Workflow PR is not offered while rework is in flight / ticket open.
    expect(await coordinator.nextActions()).toEqual([]);

    await workers.emit("implement-42-43-r2", {
      type: "stage-result",
      workerId: "implement-42-43-r2",
      outcome: { status: "completed", summary: "Reworked #43" },
    });
    await coordinator.confirmDisposition("close");

    const idsAfter = (await coordinator.nextActions()).map((a) => a.id);
    expect(idsAfter).toContain(OPEN_WORKFLOW_PR_ACTION.id);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("CLOSED");
  });

  it("numbers rework attempts without reusing a completed workspace identity (pre-merge)", async () => {
    // Existing leave-open path already numbers attempts; rework of a closed ticket uses the same numbering.
    const { coordinator, workers, workspace } = await driveAllTicketsComplete();
    await coordinator.runNextAction(reworkTicketActionId(44));
    await workers.emit("implement-42-44-r2", {
      type: "stage-result",
      workerId: "implement-42-44-r2",
      outcome: { status: "completed" },
    });
    await coordinator.confirmDisposition("leave-open");
    const third = await coordinator.runNextAction(implementTicketActionId(44));
    expect(third).toMatchObject({
      status: "running",
      attempt: 3,
      branchName: "matt-auto/42/ticket-44/r3",
    });
    expect(workspace.state.creates.map((c) => `${c.ticketNumber}/r${c.attempt}`)).toEqual(
      expect.arrayContaining(["44/r1", "44/r2", "44/r3"]),
    );
  });

  it("creates a Follow-up workflow with a new spec issue after merge rather than mutating the completed workflow", async () => {
    const { coordinator, tracker } = await driveAllTicketsComplete();
    await coordinator.runNextAction(OPEN_WORKFLOW_PR_ACTION.id);
    await coordinator.runNextAction(MERGE_WORKFLOW_PR_ACTION.id);
    await coordinator.runNextAction(CLEANUP_WORKFLOW_ACTION.id);

    const originalManifest = structuredClone(tracker.state.manifests.get(42)!);
    const followUp = await coordinator.runNextAction(START_FOLLOW_UP_ACTION.id);
    expect(followUp).toMatchObject({
      status: "completed",
      stage: "follow-up",
      followUpOf: 42,
    });
    expect(followUp.status === "completed" && followUp.workflowId).not.toBe(42);

    const newId = followUp.status === "completed" ? followUp.workflowId : undefined;
    expect(newId).toBeDefined();
    const newManifest = tracker.state.manifests.get(newId!);
    expect(newManifest).toMatchObject({
      workflowId: newId,
      stage: "spec-published",
      followUpOf: 42,
      targetBranch: DEFAULT_TARGET_BRANCH,
    });
    // Original completed workflow is not mutated beyond its completed stage.
    expect(tracker.state.manifests.get(42)).toEqual(originalManifest);
    expect(tracker.state.manifests.get(42)?.stage).toBe("completed");
    expect(tracker.state.manifests.get(42)?.integrationBranch).toBe("matt-auto/42/integration");

    const active = await coordinator.getActiveWorkflow();
    expect(active).toMatchObject({
      workflowId: newId,
      stage: "spec-published",
      followUpOf: 42,
    });
    await expect(coordinator.nextActions()).resolves.toEqual([
      expect.objectContaining({ id: CREATE_TICKETS_ACTION.id }),
    ]);
  });

  it("does not offer Follow-up mutation path for pre-merge rework", async () => {
    const { coordinator } = await driveAllTicketsComplete();
    const ids = (await coordinator.nextActions()).map((a) => a.id);
    expect(ids).toContain(reworkTicketActionId(43));
    expect(ids).not.toContain(START_FOLLOW_UP_ACTION.id);
    expect(ids).not.toContain(CLEANUP_WORKFLOW_ACTION.id);
  });
});

describe("Workflow coordinator Pipeline pause and Run termination", () => {
  it("Pause aborts session-owned workers, sets pipelinePaused, and leaves GitHub untouched", async () => {
    const { coordinator, workers, tracker, transcripts, remoteGit } =
      ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    const manifestWritesBefore = tracker.state.writeManifestCalls;
    const issueStatesBefore = tracker.state.issues.map((i) => ({
      number: i.number,
      state: i.state,
    }));

    const paused = await coordinator.pausePipeline();
    expect(paused).toEqual({
      abortedWorkerCount: 1,
      affectedAttempts: [
        {
          workflowId: 42,
          ticketNumber: 43,
          attempt: 1,
          kind: "implementation",
        },
      ],
      pipelinePaused: true,
    });
    expect(workers.state.abortAllCount).toBe(1);
    expect(workers.state.aborts).toContain("implement-42-43-r1");
    expect(coordinator.isPipelinePaused()).toBe(true);
    expect(coordinator.isAutoAdvanceBlocked()).toBe(true);
    expect(coordinator.isRunTerminated()).toBe(false);

    const panel = await coordinator.getPanelState();
    expect(panel?.pipelinePaused).toBe(true);
    expect(panel?.lastStopReason).toBe("pipeline-pause");
    expect(panel?.workers ?? []).toEqual([]);

    // No GitHub mutations on Pause.
    expect(tracker.state.writeManifestCalls).toBe(manifestWritesBefore);
    expect(
      tracker.state.issues.map((i) => ({ number: i.number, state: i.state })),
    ).toEqual(issueStatesBefore);
    expect(remoteGit.state.pushes).toEqual([]);
    expect(remoteGit.state.deleted).toEqual([]);

    const events = await transcripts.port.read({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 1,
    });
    expect(
      events.some((e) => (e as { type?: string }).type === "pipeline:pause"),
    ).toBe(true);
  });

  it("Resume clears Pipeline pause so auto-advance can select Next again", async () => {
    const { coordinator, workers } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.pausePipeline();
    expect(coordinator.isAutoAdvanceBlocked()).toBe(true);

    const resumed = await coordinator.resumePipeline();
    expect(resumed).toEqual({ pipelinePaused: false });
    expect(coordinator.isPipelinePaused()).toBe(false);
    expect(coordinator.isAutoAdvanceBlocked()).toBe(false);

    const panel = await coordinator.getPanelState();
    expect(panel?.pipelinePaused).toBe(false);
    expect(panel?.lastStopReason).toBeUndefined();

    // Orchestration-only: does not relaunch the aborted worker dialogue.
    expect(workers.state.launches).toHaveLength(1);

    // Without recovery cooldown, Next can offer the ticket again after Pause.
    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toContain(implementTicketActionId(43));
  });

  it("Terminate before integrate uses T2 discard-unintegrated and removes attempt artifacts only", async () => {
    const { coordinator, workers, workspace, tracker, transcripts, remoteGit } =
      ticketsPublishedFixture();

    // Create two unintegrated attempt workspaces (single-worker path: pause between).
    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.pausePipeline();
    await coordinator.resumePipeline();
    await coordinator.runNextAction(implementTicketActionId(44));

    const manifestWritesBefore = tracker.state.writeManifestCalls;
    const issuesBefore = structuredClone(tracker.state.issues);
    const manifestBefore = structuredClone(tracker.state.manifests.get(42));

    const terminated = await coordinator.terminateRun();
    expect(terminated.mode).toBe("discard-unintegrated");
    expect(terminated.runTerminated).toBe(true);
    expect(terminated.abortedWorkerCount).toBe(1);
    expect(terminated.affectedAttempts).toEqual([
      {
        workflowId: 42,
        ticketNumber: 44,
        attempt: 1,
        kind: "implementation",
      },
    ]);
    expect(terminated.discardedBranches).toEqual(
      expect.arrayContaining([
        "matt-auto/42/ticket-43/r1",
        "matt-auto/42/ticket-44/r1",
        "matt-auto/42/integration",
      ]),
    );
    expect(workspace.state.removeLocalBranchesCalls.length).toBeGreaterThan(0);
    expect(workers.state.aborts).toContain("implement-42-44-r1");

    expect(coordinator.isRunTerminated()).toBe(true);
    expect(coordinator.isPipelinePaused()).toBe(false);
    expect(coordinator.isAutoAdvanceBlocked()).toBe(true);

    const panel = await coordinator.getPanelState();
    expect(panel?.runTerminated).toBe(true);
    expect(panel?.lastStopReason).toBe("run-termination");
    expect(panel?.terminationMode).toBe("discard-unintegrated");

    // GitHub history untouched (no integrate/PR rewrite, no ticket reopen).
    expect(tracker.state.writeManifestCalls).toBe(manifestWritesBefore);
    expect(tracker.state.manifests.get(42)).toEqual(manifestBefore);
    expect(tracker.state.issues).toEqual(issuesBefore);
    expect(remoteGit.state.deleted).toEqual([]);

    const events44 = await transcripts.port.read({
      workflowId: 42,
      ticketNumber: 44,
      attempt: 1,
    });
    expect(
      events44.some(
        (e) => (e as { type?: string }).type === "pipeline:terminate",
      ),
    ).toBe(true);

    // Discarded attempts no longer count toward latestAttempt.
    expect(await workspace.port.latestAttempt(42, 43)).toBe(0);
    expect(await workspace.port.latestAttempt(42, 44)).toBe(0);
  });

  it("Terminate after successful Integration unit uses T1 stop-only and never discards integrated artifacts", async () => {
    const { coordinator, workers, workspace, tracker, remoteGit } =
      ticketsPublishedFixture();

    // Integrate #43 successfully (pending CI).
    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: { status: "completed", summary: "Done #43" },
    });
    await coordinator.confirmDisposition("close");
    expect(tracker.state.manifests.get(42)?.integratedTickets).toEqual([
      {
        number: 43,
        attempt: 1,
        branchName: "matt-auto/42/ticket-43/r1",
      },
    ]);

    // Start another unintegrated worker, then terminate.
    await coordinator.runNextAction(implementTicketActionId(44));
    const manifestWritesBefore = tracker.state.writeManifestCalls;
    const integratedBefore = structuredClone(
      tracker.state.manifests.get(42)?.integratedTickets,
    );
    const pushesBefore = [...remoteGit.state.pushes];

    const terminated = await coordinator.terminateRun();
    expect(terminated.mode).toBe("stop-only");
    expect(terminated.discardedBranches).toEqual([]);
    expect(terminated.discardedWorktrees).toEqual([]);
    expect(terminated.abortedWorkerCount).toBe(1);
    expect(workspace.state.removeLocalBranchesCalls).toEqual([]);

    // Integrated history preserved; no remote deletes; no manifest rewrite.
    expect(tracker.state.writeManifestCalls).toBe(manifestWritesBefore);
    expect(tracker.state.manifests.get(42)?.integratedTickets).toEqual(
      integratedBefore,
    );
    expect(remoteGit.state.pushes).toEqual(pushesBefore);
    expect(remoteGit.state.deleted).toEqual([]);
    expect(tracker.state.issues.find((i) => i.number === 43)?.state).toBe("OPEN");

    const panel = await coordinator.getPanelState();
    expect(panel?.terminationMode).toBe("stop-only");
    expect(panel?.lastStopReason).toBe("run-termination");
    expect(coordinator.isRunTerminated()).toBe(true);
  });

  it("Terminate with a Workflow PR present is T1 stop-only even without integratedTickets length edge cases", async () => {
    const tracker = createTracker({
      active: {
        workflowId: 42,
        targetBranch: DEFAULT_TARGET_BRANCH,
        stage: "pr-opened",
        workerProfile: defaultWorkerProfile,
        title: "Existing spec",
        tickets: [43],
        integrationBranch: "matt-auto/42/integration",
        integratedTickets: [
          {
            number: 43,
            attempt: 1,
            branchName: "matt-auto/42/ticket-43/r1",
          },
        ],
        workflowPr: {
          number: 99,
          url: "https://example.test/pr/99",
          baseBranch: DEFAULT_TARGET_BRANCH,
          headBranch: "matt-auto/42/integration",
        },
      },
      tickets: [{ number: 43, title: "Ship core path", state: "CLOSED", blockedBy: [] }],
    });
    const workspace = createWorkspace("/repo");
    const ports = createPorts({
      defaultRoot: {
        preferences: { globalWorkerProfile: defaultWorkerProfile },
        tracker,
        workspace,
      },
    });
    const coordinator = createWorkflowCoordinator(ports);

    const terminated = await coordinator.terminateRun();
    expect(terminated.mode).toBe("stop-only");
    expect(terminated.discardedBranches).toEqual([]);
    expect(workspace.state.removeLocalBranchesCalls).toEqual([]);
    expect(coordinator.isRunTerminated()).toBe(true);
  });

  it("beginPipelineRun clears pause and termination so a new run can auto-advance", async () => {
    const { coordinator } = ticketsPublishedFixture();
    await coordinator.pausePipeline();
    expect(coordinator.isAutoAdvanceBlocked()).toBe(true);

    coordinator.beginPipelineRun();
    expect(coordinator.isPipelinePaused()).toBe(false);
    expect(coordinator.isRunTerminated()).toBe(false);
    expect(coordinator.isAutoAdvanceBlocked()).toBe(false);

    await coordinator.terminateRun();
    expect(coordinator.isAutoAdvanceBlocked()).toBe(true);
    coordinator.beginPipelineRun();
    expect(coordinator.isAutoAdvanceBlocked()).toBe(false);
  });

  it("exposes pipelinePaused on panel even when no workers are running", async () => {
    const { coordinator } = ticketsPublishedFixture();
    const before = await coordinator.getPanelState();
    expect(before?.pipelinePaused).toBe(false);

    await coordinator.pausePipeline();
    const after = await coordinator.getPanelState();
    expect(after?.pipelinePaused).toBe(true);
    expect(after?.lastStopReason).toBe("pipeline-pause");
    expect(after?.workers).toEqual([]);
  });
});

describe("Workflow coordinator Resume prefers latest unintegrated Implementation attempt", () => {
  it("surfaces disposition for a completed attempt after abort/resume instead of re-implementing", async () => {
    const { coordinator, workers, workspace } = ticketsPublishedFixture();

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: {
        status: "completed",
        summary: "landed before pause",
        localCommitSha: "abc12345",
      },
    });

    // Pause after completion is a no-op for workers, but Resume must still not
    // open r2 when the completed attempt is unrecovered only via implement.
    await coordinator.pausePipeline();
    await coordinator.resumePipeline();

    const actions = await coordinator.nextActions();
    expect(actions.map((a) => a.id)).toEqual([dispositionActionId(43)]);
    expect(actions.map((a) => a.id)).not.toContain(implementTicketActionId(43));

    // Explicit implement seam also prefers disposition over rN+1.
    const result = await coordinator.runNextAction(implementTicketActionId(43));
    expect(result).toMatchObject({
      status: "failed",
      stage: "implement",
      ticketNumber: 43,
    });
    expect(String((result as { reason?: string }).reason ?? "")).toMatch(
      /disposition/i,
    );

    // No fresh workspace created beyond the original r1.
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1]);
    expect(workers.state.launches).toHaveLength(1);
  });

  it("relaunches on the same attempt branch when incomplete work has commits ahead", async () => {
    const workspace = createWorkspace("/repo");
    workspace.port.hasCommitsAhead = async () => ({
      ahead: true,
      headSha: "partial01",
      count: 2,
    });
    const { coordinator, workers } = ticketsPublishedFixture({ workspace });

    await coordinator.runNextAction(implementTicketActionId(43));
    expect(workers.state.launches).toHaveLength(1);
    expect(workers.state.launches[0]?.attempt).toBe(1);

    await coordinator.pausePipeline();
    await coordinator.resumePipeline();

    const relaunch = await coordinator.runNextAction(
      implementTicketActionId(43),
    );
    expect(relaunch).toMatchObject({
      status: "running",
      stage: "implement",
      ticketNumber: 43,
      attempt: 1,
      branchName: "matt-auto/42/ticket-43/r1",
      workerId: "implement-42-43-r1",
    });

    // Same attempt workspace ensured; no silent orphan r2 create.
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1]);
    expect(
      workspace.state.ensures.some(
        (e) => e.ticketNumber === 43 && e.attempt === 1,
      ),
    ).toBe(true);
    expect(workers.state.launches).toHaveLength(2);
    expect(workers.state.launches[1]?.attempt).toBe(1);
    expect(workers.state.launches[1]?.branchName).toBe(
      "matt-auto/42/ticket-43/r1",
    );
    expect(workers.state.launches[1]?.prompt).toMatch(/Resume note/);
    expect(workers.state.launches[1]?.prompt).toMatch(/r1/);
    expect(workers.state.launches[1]?.prompt).toMatch(/not available|dialogue/i);
  });

  it("opens a fresh attempt when the latest attempt is empty/failed", async () => {
    const workspace = createWorkspace("/repo");
    // Default hasCommitsAhead is empty (ahead: false).
    const { coordinator, workers } = ticketsPublishedFixture({ workspace });

    await coordinator.runNextAction(implementTicketActionId(43));
    await coordinator.pausePipeline();
    await coordinator.resumePipeline();

    const relaunch = await coordinator.runNextAction(
      implementTicketActionId(43),
    );
    expect(relaunch).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
      workerId: "implement-42-43-r2",
    });
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1, 2]);
    expect(workers.state.launches).toHaveLength(2);
    expect(workers.state.launches[1]?.attempt).toBe(2);
    // Fresh attempt does not claim resume-of-dialogue semantics.
    expect(workers.state.launches[1]?.prompt).not.toMatch(/Resume note/);
  });

  it("after leave-open disposition opens a fresh attempt rather than reusing completed workspace", async () => {
    const workspace = createWorkspace("/repo");
    workspace.port.hasCommitsAhead = async () => ({
      ahead: true,
      headSha: "done0001",
      count: 3,
    });
    const { coordinator, workers } = ticketsPublishedFixture({ workspace });

    await coordinator.runNextAction(implementTicketActionId(43));
    await workers.emit("implement-42-43-r1", {
      type: "stage-result",
      workerId: "implement-42-43-r1",
      outcome: { status: "completed", summary: "first pass" },
    });
    await coordinator.confirmDisposition("leave-open");

    const relaunch = await coordinator.runNextAction(
      implementTicketActionId(43),
    );
    expect(relaunch).toMatchObject({
      status: "running",
      attempt: 2,
      branchName: "matt-auto/42/ticket-43/r2",
    });
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([1, 2]);
    expect(workers.state.launches[1]?.prompt).not.toMatch(/Resume note/);
  });

  it("recovers disposition from transcript for completed attempt without launching rN+1", async () => {
    const attempts = new Map<string, number>([["42:43", 3]]);
    const workspace = createWorkspace("/repo", { attempts });
    // Seed a prior create so ensure/reuse paths have a workspace row if hit.
    workspace.state.creates.push({
      workflowId: 42,
      ticketNumber: 43,
      attempt: 3,
      baseRef: "main",
      branchName: "matt-auto/42/ticket-43/r3",
      worktreePath: "/matt-auto-workspaces/42/ticket-43/r3",
    });
    const transcripts = createTranscripts();
    await transcripts.port.append(
      { workflowId: 42, ticketNumber: 43, attempt: 3 },
      {
        type: "stage-result",
        workerId: "implement-42-43-r3",
        outcome: {
          status: "completed",
          summary: "finished offline",
          localCommitSha: "cafebabe",
        },
      },
    );

    const { coordinator, workers } = ticketsPublishedFixture({
      workspace,
      transcripts,
    });

    // Direct implement (skipping nextActions recovery first) still prefers disposition.
    const result = await coordinator.runNextAction(implementTicketActionId(43));
    expect(result).toMatchObject({
      status: "needs-disposition",
      stage: "implement",
      ticketNumber: 43,
      attempt: 3,
      branchName: "matt-auto/42/ticket-43/r3",
    });
    expect(workers.state.launches).toHaveLength(0);
    expect(workspace.state.creates.map((c) => c.attempt)).toEqual([3]);
  });
});
