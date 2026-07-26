import path from "node:path";
import {
  checkCiActionId,
  CI_RECOVERY_OPTIONS,
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
  parseCheckCiActionId,
  parseCiRecoveryActionId,
  parseDispositionActionId,
  parseImplementTicketActionId,
  parseIntegrateTicketActionId,
  parseReworkTicketActionId,
  REQUIRED_MATT_SKILLS,
  reworkTicketActionId,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
  START_FOLLOW_UP_ACTION,
  TICKET_ISSUE_LABEL,
  TICKET_PROGRESS_ACTION,
  UNSUPPORTED_TRACKER_REASON,
  WORKFLOW_MANIFEST_SCHEMA,
} from "./constants.js";
import { isPublishableSpecDraft } from "./adapters/planning-draft.js";
import { workerTranscriptPath } from "./adapters/transcripts.js";
import { implementationWorktreePath } from "./adapters/workspace.js";
import type {
  RootScopedPorts,
  TrackerTicket,
  WorkerEventSink,
  WorkflowCoordinatorPorts,
} from "./ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  CiRecoveryDecision,
  ImplementationDispositionDecision,
  ImplementationWorkerStatus,
  IntegratedTicketRef,
  NextAction,
  PipelineAffectedAttempt,
  PipelinePauseResult,
  PipelineResumeResult,
  PreflightCheck,
  PreflightResult,
  ReadyTicket,
  ResolvedWorkerProfile,
  RunTerminationMode,
  RunTerminationResult,
  SpecDraft,
  StageConfirmationDecision,
  StageResult,
  TicketDraft,
  TicketProgressSummary,
  TicketsDraft,
  WorkerProfile,
  WorkerProtocolEvent,
  WorkflowCoordinator,
  WorkflowManifest,
  WorkflowPanelState,
  WorkflowRoot,
  WorkflowRootKind,
  WorkflowStage,
} from "./types.js";

type PendingCreateSpec = {
  stage: "create-spec";
  draft: SpecDraft;
};

type PendingCreateTickets = {
  stage: "create-tickets";
  draft: TicketsDraft;
  workflowId: number;
  workflowTitle?: string;
};

type PendingStage = PendingCreateSpec | PendingCreateTickets;

type ActiveImplementationWorker = {
  workerId: string;
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  status: ImplementationWorkerStatus;
  progress?: string;
  summary?: string;
  /** OS pid of the `pi --mode json` child when known. */
  pid?: number;
  /** True once a stage-result event was handled for this worker. */
  receivedStageResult: boolean;
};

/**
 * Session-owned Conflict resolution worker for an in-progress Integration merge.
 * Runs the installed resolving-merge-conflicts skill in the Integration workspace.
 */
type ActiveConflictWorker = {
  workerId: string;
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  integrationBranch: string;
  integrationWorktreePath: string;
  status: ImplementationWorkerStatus;
  progress?: string;
  /** OS pid of the conflict-resolution child when known. */
  pid?: number;
  receivedStageResult: boolean;
};

/**
 * One completed ticket waiting for (or retrying) a serialized Integration unit.
 * Only one Integration unit runs at a time; tickets do not close yet.
 */
type PendingIntegration = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  lastFailure?: string;
  /**
   * Set when a merge conflict left an in-progress merge for Conflict resolution.
   * While present, retries re-launch the Conflict resolution worker instead of re-merging.
   */
  conflict?: {
    integrationBranch: string;
    integrationWorktreePath: string;
    message: string;
  };
};

type PendingCiRecovery = {
  workflowId: number;
  ticketNumber: number;
  attempt: number;
  branchName: string;
  worktreePath: string;
  integrationBranch: string;
  url?: string;
  summary?: string;
};


/**
 * Create the Workflow coordinator — the sole product seam for Matt Auto.
 *
 * Product rules (root selection, preflight, Worker profile precedence, Next
 * actions, later stages) live here. Adapters are injected as ports and are not
 * part of this interface.
 */
export function createWorkflowCoordinator(
  ports: WorkflowCoordinatorPorts,
): WorkflowCoordinator {
  let selectedPath: string | undefined;
  let scoped: RootScopedPorts | undefined;
  /** Session-local pending Stage confirmation (never remote until Publish). */
  let pending: PendingStage | undefined;
  /**
   * Session-owned Implementation worker (single path for this ticket).
   * Lifetime is bound to Workflow home; never durable across processes.
   */
  let activeWorker: ActiveImplementationWorker | undefined;
  /** Pending Implementation disposition after a successful worker Stage result. */
  let pendingDisposition: ActiveImplementationWorker | undefined;
  /**
   * Pending Integration unit after Close disposition (or a fail-closed retry).
   * Serialized: at most one ticket at a time.
   */
  let pendingIntegration: PendingIntegration | undefined;
  /** Guard against re-entrant Integration unit execution. */
  let integrationInProgress = false;
  /**
   * Session-owned Conflict resolution worker for a preserved in-progress merge.
   * Lifetime is bound to Workflow home; never durable across processes.
   */
  let activeConflictWorker: ActiveConflictWorker | undefined;
  let pendingCiRecovery: PendingCiRecovery | undefined;
  /**
   * Session pointer to the most recently cleaned-up workflow on this Target branch.
   * Enables Start Follow-up without mutating the completed workflow.
   */
  let lastCompletedWorkflow:
    | { workflowId: number; title?: string; targetBranch: string }
    | undefined;
  /** Ticket numbers that recently hit implementation recovery — skip auto re-launch. */
  const implementationRecoveryCooldown = new Map<number, number>();
  const IMPLEMENTATION_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;
  /**
   * Session-owned Pipeline pause flag. When true, auto-advance / preferred Next
   * must not continue the run loop. Cleared only by Resume or beginPipelineRun.
   */
  let pipelinePaused = false;
  /** Session-owned Run termination flag until the next explicit pipeline run. */
  let runTerminated = false;
  /** Last operator stop that affected the run loop (panel / brief surface). */
  let lastStopReason: "pipeline-pause" | "run-termination" | undefined;
  /** T1/T2 mode recorded when lastStopReason is run-termination. */
  let lastTerminationMode: RunTerminationMode | undefined;

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

  async function requireScoped(): Promise<RootScopedPorts> {
    await ensureSelected();
    if (!scoped) {
      throw new Error("Workflow root ports are not bound.");
    }
    return scoped;
  }

  async function resolveTargetBranch(
    preferences: RootScopedPorts["preferences"],
  ): Promise<string> {
    const configured = await preferences.getConfiguredTargetBranch();
    return configured ?? DEFAULT_TARGET_BRANCH;
  }

  /**
   * Rebuild in-memory Integration / disposition state from transcripts so a new
   * /matt-auto run does not re-Implement tickets that already completed (or
   * already failed Integration after Close).
   */
  async function recoverPendingDispositionFromTranscripts(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<void> {
    if (pendingDisposition || pendingIntegration || activeWorker) return;
    const ticketNumbers = active.tickets ?? [];
    const rootPath = selectedPath ?? ports.startPath;

    for (const ticketNumber of ticketNumbers) {
      if (
        (active.integratedTickets ?? []).some((t) => t.number === ticketNumber)
      ) {
        continue;
      }
      const attempt = await bound.workspace.latestAttempt(
        active.workflowId,
        ticketNumber,
      );
      if (attempt < 1) continue;

      const events = await bound.transcripts.read({
        workflowId: active.workflowId,
        ticketNumber,
        attempt,
      });

      let completed = false;
      let closedForIntegrate = false;
      let integrationFailedReason: string | undefined;
      let summary: string | undefined;
      let headSha: string | undefined;

      for (const raw of events) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Record<string, unknown>;
        const type = e.type;

        if (type === "compatibility-recovery" || type === "worker-aborted") {
          completed = false;
          closedForIntegrate = false;
          integrationFailedReason = undefined;
          summary = undefined;
          headSha = undefined;
          continue;
        }

        if (type === "stage-result") {
          const outcome = e.outcome as Record<string, unknown> | undefined;
          if (outcome?.status === "completed") {
            completed = true;
            closedForIntegrate = false;
            integrationFailedReason = undefined;
            if (typeof outcome.summary === "string") summary = outcome.summary;
            if (typeof outcome.localCommitSha === "string") {
              headSha = outcome.localCommitSha;
            }
          } else {
            completed = false;
            closedForIntegrate = false;
            integrationFailedReason = undefined;
            summary = undefined;
            headSha = undefined;
          }
          continue;
        }

        if (type === "stage-result-inferred") {
          completed = true;
          closedForIntegrate = false;
          integrationFailedReason = undefined;
          if (typeof e.headSha === "string") headSha = e.headSha;
          summary =
            typeof e.reason === "string"
              ? e.reason
              : "Inferred completion from local commits";
          continue;
        }

        if (type === "disposition") {
          const decision = e.decision;
          if (decision === "close" && completed) {
            // Close was chosen — Integration may still be pending/failed.
            closedForIntegrate = true;
            integrationFailedReason = undefined;
          } else {
            // leave-open / investigate: not waiting on Integration.
            completed = false;
            closedForIntegrate = false;
            integrationFailedReason = undefined;
            summary = undefined;
            headSha = undefined;
          }
          continue;
        }

        if (type === "integration-unit-failed") {
          if (closedForIntegrate || completed) {
            closedForIntegrate = true;
            integrationFailedReason =
              typeof e.reason === "string"
                ? e.reason
                : "Integration unit failed";
          }
          continue;
        }

        if (
          type === "integration-unit-complete" ||
          type === "integration-unit-skipped"
        ) {
          completed = false;
          closedForIntegrate = false;
          integrationFailedReason = undefined;
        }
      }

      const branchName = implementationBranchName(
        active.workflowId,
        ticketNumber,
        attempt,
      );
      const worktreePath = implementationWorktreePath(
        rootPath,
        active.workflowId,
        ticketNumber,
        attempt,
      );

      // Prefer retrying a failed Integration over re-Implementing.
      if (closedForIntegrate && integrationFailedReason) {
        pendingIntegration = {
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          branchName,
          worktreePath,
          lastFailure: integrationFailedReason,
        };
        implementationRecoveryCooldown.delete(ticketNumber);
        return;
      }

      // Completed implement, never Closed (or Close not recorded).
      if (completed && !closedForIntegrate) {
        pendingDisposition = {
          workerId: `recovered-${active.workflowId}-${ticketNumber}-r${attempt}`,
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          branchName,
          worktreePath,
          status: "needs-disposition",
          receivedStageResult: true,
          summary:
            summary ??
            (headSha
              ? `Recovered completed attempt r${attempt} @ ${headSha.slice(0, 8)}`
              : `Recovered completed attempt r${attempt}`),
        };
        implementationRecoveryCooldown.delete(ticketNumber);
        return;
      }
    }
  }

  async function loadActiveWorkflow(
    bound: RootScopedPorts,
  ): Promise<ActiveWorkflow | undefined> {
    const targetBranch = await resolveTargetBranch(bound.preferences);
    const hint = await bound.preferences.getActiveWorkflowId(targetBranch);
    const active = await bound.tracker.findActiveWorkflow(
      targetBranch,
      hint,
    );
    // Keep / refresh the rebuildable local pointer for fast subsequent opens.
    if (active) {
      await bound.preferences.setActiveWorkflowId(
        targetBranch,
        active.workflowId,
      );
    } else if (hint !== undefined) {
      await bound.preferences.clearActiveWorkflowId(targetBranch);
    }
    return active;
  }

  /**
   * Worker profile precedence: workflow-snapshot → workflow-root → global.
   * Snapshot comes from local cache or the Active workflow manifest on GitHub.
   */
  async function resolveWorkerProfile(
    bound: RootScopedPorts,
  ): Promise<ResolvedWorkerProfile | undefined> {
    const snapshot = await bound.preferences.getWorkflowSnapshotWorkerProfile();
    if (snapshot) {
      return { profile: snapshot, source: "workflow-snapshot" };
    }

    const active = await loadActiveWorkflow(bound);
    if (active?.workerProfile) {
      return { profile: active.workerProfile, source: "workflow-snapshot" };
    }

    const root = await bound.preferences.getRootWorkerProfile();
    if (root) {
      return { profile: root, source: "workflow-root" };
    }
    const global = await bound.preferences.getGlobalWorkerProfile();
    if (global) {
      return { profile: global, source: "global" };
    }
    return undefined;
  }

  function isUsableDraft(draft: SpecDraft): boolean {
    return isPublishableSpecDraft(draft);
  }

  function validateTicketsDraft(
    draft: TicketsDraft,
  ): { ok: true; tickets: TicketDraft[] } | { ok: false; reason: string } {
    if (!draft.tickets || draft.tickets.length === 0) {
      return {
        ok: false,
        reason:
          "Create-tickets skill returned an empty breakdown. Matt Auto entered Compatibility recovery rather than publishing.",
      };
    }

    const seen = new Set<string>();
    const tickets: TicketDraft[] = [];

    for (const raw of draft.tickets) {
      const localId = raw.localId?.trim() ?? "";
      const title = raw.title?.trim() ?? "";
      const body = raw.body ?? "";
      if (!localId) {
        return {
          ok: false,
          reason:
            "Create-tickets skill returned a ticket missing a localId. Matt Auto entered Compatibility recovery rather than publishing.",
        };
      }
      if (seen.has(localId)) {
        return {
          ok: false,
          reason: `Create-tickets skill returned duplicate localId "${localId}". Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      seen.add(localId);
      if (!title) {
        return {
          ok: false,
          reason: `Create-tickets skill returned ticket "${localId}" without a title. Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      if (!body.trim()) {
        return {
          ok: false,
          reason: `Create-tickets skill returned ticket "${localId}" without a body. Matt Auto entered Compatibility recovery rather than publishing.`,
        };
      }
      tickets.push({
        localId,
        title,
        body,
        blockedBy: [...(raw.blockedBy ?? [])],
      });
    }

    const ids = new Set(tickets.map((t) => t.localId));
    for (const ticket of tickets) {
      for (const blocker of ticket.blockedBy) {
        if (!ids.has(blocker)) {
          return {
            ok: false,
            reason: `Create-tickets skill returned ticket "${ticket.localId}" blocked by unknown localId "${blocker}". Matt Auto entered Compatibility recovery rather than publishing.`,
          };
        }
        if (blocker === ticket.localId) {
          return {
            ok: false,
            reason: `Create-tickets skill returned ticket "${ticket.localId}" blocked by itself. Matt Auto entered Compatibility recovery rather than publishing.`,
          };
        }
      }
    }

    // Cycle detection via DFS.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(tickets.map((t) => [t.localId, t]));

    function hasCycle(id: string): boolean {
      if (visited.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      const node = byId.get(id);
      for (const blocker of node?.blockedBy ?? []) {
        if (hasCycle(blocker)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }

    for (const ticket of tickets) {
      if (hasCycle(ticket.localId)) {
        return {
          ok: false,
          reason:
            "Create-tickets skill returned a cyclic blockedBy graph. Matt Auto entered Compatibility recovery rather than publishing.",
        };
      }
    }

    return { ok: true, tickets };
  }

  /** Topological order: blockers before dependents (stable by input order). */
  function topologicalOrder(tickets: readonly TicketDraft[]): TicketDraft[] {
    const byId = new Map(tickets.map((t) => [t.localId, t]));
    const remaining = new Set(tickets.map((t) => t.localId));
    const ordered: TicketDraft[] = [];

    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => {
        const ticket = byId.get(id);
        return (ticket?.blockedBy ?? []).every((b) => !remaining.has(b));
      });
      // Preserve original relative order among ready tickets.
      const readyInOrder = tickets.filter((t) => ready.includes(t.localId));
      if (readyInOrder.length === 0) {
        // Should be unreachable after cycle validation.
        break;
      }
      for (const ticket of readyInOrder) {
        ordered.push(ticket);
        remaining.delete(ticket.localId);
      }
    }

    return ordered;
  }

  function stripManagedSections(body: string): string {
    // Remove Parent / Blocked by sections the skill may have drafted so publish
    // can write canonical GitHub references.
    return body
      .split(/(?=^##\s)/m)
      .filter((section) => {
        const header = /^##\s*(.+?)(?:\r?\n|$)/.exec(section);
        const name = header?.[1]?.trim().toLowerCase();
        return name !== "parent" && name !== "blocked by";
      })
      .join("")
      .trim();
  }

  function formatPublishedTicketBody(
    draft: TicketDraft,
    workflowId: number,
    workflowTitle: string | undefined,
    blockers: readonly { number: number; title: string }[],
  ): string {
    const parentLine = workflowTitle
      ? `#${workflowId} ${workflowTitle}`
      : `#${workflowId}`;
    const core = stripManagedSections(draft.body);
    const blockedBySection =
      blockers.length === 0
        ? "None — can start immediately."
        : blockers.map((b) => `- #${b.number} ${b.title}`).join("\n");

    return [
      "## Parent",
      "",
      parentLine,
      "",
      core,
      "",
      "## Blocked by",
      "",
      blockedBySection,
      "",
    ].join("\n");
  }

  function computeTicketProgress(
    workflowId: number,
    tickets: readonly TrackerTicket[],
    integratedNumbers: ReadonlySet<number> = new Set(),
  ): TicketProgressSummary {
    const open = tickets.filter((t) => t.state === "OPEN");
    const closed = tickets.filter((t) => t.state === "CLOSED");

    const ready: ReadyTicket[] = [];
    const blocked: TicketProgressSummary["blocked"][number][] = [];
    const awaitingCi: ReadyTicket[] = [];

    const sortedOpen = [...open].sort((a, b) => a.number - b.number);

    for (const ticket of sortedOpen) {
      if (integratedNumbers.has(ticket.number)) {
        awaitingCi.push({ number: ticket.number, title: ticket.title });
        continue;
      }

      const openBlockers = ticket.blockedBy
        .filter((b) => b.state === "OPEN")
        .map((b) => b.number)
        .sort((a, b) => a - b);

      if (openBlockers.length === 0) {
        ready.push({ number: ticket.number, title: ticket.title });
      } else {
        blocked.push({
          number: ticket.number,
          title: ticket.title,
          openBlockers,
        });
      }
    }

    return {
      workflowId,
      total: tickets.length,
      open: open.length,
      closed: closed.length,
      ready,
      blocked,
      awaitingCi,
    };
  }

  function isTicketWorkStage(stage: WorkflowStage): boolean {
    return stage === "tickets-published" || stage === "pr-opened";
  }

  function allTicketsComplete(progress: TicketProgressSummary): boolean {
    return (
      progress.total > 0 &&
      progress.closed === progress.total &&
      progress.open === 0 &&
      progress.awaitingCi.length === 0 &&
      progress.ready.length === 0
    );
  }

  function manifestFromActive(
    active: ActiveWorkflow,
    overrides: Partial<WorkflowManifest> = {},
  ): WorkflowManifest {
    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: active.workflowId,
      targetBranch: active.targetBranch,
      stage: overrides.stage ?? active.stage,
      workerProfile: active.workerProfile,
    };
    const tickets = overrides.tickets ?? active.tickets;
    if (tickets) {
      manifest.tickets = [...tickets];
    }
    const integrationBranch =
      overrides.integrationBranch ?? active.integrationBranch;
    if (integrationBranch) {
      manifest.integrationBranch = integrationBranch;
    }
    const integratedTickets =
      overrides.integratedTickets ?? active.integratedTickets;
    if (integratedTickets) {
      manifest.integratedTickets = [...integratedTickets];
    }
    const workflowPr =
      overrides.workflowPr !== undefined
        ? overrides.workflowPr
        : active.workflowPr;
    if (workflowPr) {
      manifest.workflowPr = { ...workflowPr };
    }
    const followUpOf =
      overrides.followUpOf !== undefined
        ? overrides.followUpOf
        : active.followUpOf;
    if (followUpOf !== undefined) {
      manifest.followUpOf = followUpOf;
    }
    return manifest;
  }

  async function loadTicketProgress(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<TicketProgressSummary | undefined> {
    if (!isTicketWorkStage(active.stage) && active.stage !== "merged") {
      return undefined;
    }
    const numbers = active.tickets ?? [];
    const integratedNumbers = new Set(
      (active.integratedTickets ?? []).map((t) => t.number),
    );
    if (numbers.length === 0) {
      return {
        workflowId: active.workflowId,
        total: 0,
        open: 0,
        closed: 0,
        ready: [],
        blocked: [],
        awaitingCi: [],
      };
    }
    const tickets = await bound.tracker.listTickets(numbers);
    return computeTicketProgress(active.workflowId, tickets, integratedNumbers);
  }

  function formatTicketProgressAction(
    progress: TicketProgressSummary,
  ): NextAction {
    const readyList =
      progress.ready.length === 0
        ? "none"
        : progress.ready.map((t) => `#${t.number}`).join(", ");
    return {
      id: TICKET_PROGRESS_ACTION.id,
      label: `${TICKET_PROGRESS_ACTION.label}: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed`,
      description: `Ready frontier: ${readyList}.`,
    };
  }

  function formatImplementAction(ticket: ReadyTicket): NextAction {
    return {
      id: implementTicketActionId(ticket.number),
      label: `Implement #${ticket.number}`,
      description: `${ticket.title}. Launch a session-owned Implementation worker in an isolated Implementation workspace.`,
    };
  }

  function panelLines(
    workflowId: number,
    progress: TicketProgressSummary | undefined,
    worker: ActiveImplementationWorker | undefined,
  ): string[] {
    const lines = [`Workflow #${workflowId}`];
    if (progress) {
      lines.push(
        `Tickets: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed`,
      );
    }
    if (worker) {
      const progressText = worker.progress ? ` — ${worker.progress}` : "";
      lines.push(
        `Worker #${worker.ticketNumber} r${worker.attempt}: ${worker.status}${progressText}`,
      );
    } else if (pendingDisposition) {
      lines.push(
        `Worker #${pendingDisposition.ticketNumber} r${pendingDisposition.attempt}: needs-disposition`,
      );
    }
    if (activeConflictWorker) {
      const progressText = activeConflictWorker.progress
        ? ` — ${activeConflictWorker.progress}`
        : "";
      lines.push(
        `Conflict resolution #${activeConflictWorker.ticketNumber} r${activeConflictWorker.attempt}: ${activeConflictWorker.status}${progressText}`,
      );
    } else if (pendingIntegration) {
      const failure = pendingIntegration.lastFailure
        ? ` — ${pendingIntegration.lastFailure}`
        : "";
      lines.push(
        `Integration #${pendingIntegration.ticketNumber} r${pendingIntegration.attempt}: pending-retry${failure}`,
      );
    }
    if (pendingCiRecovery) {
      const detail = pendingCiRecovery.summary
        ? ` — ${pendingCiRecovery.summary}`
        : "";
      lines.push(
        `CI #${pendingCiRecovery.ticketNumber} r${pendingCiRecovery.attempt}: failure${detail}`,
      );
    } else if (progress && progress.awaitingCi.length > 0) {
      const list = progress.awaitingCi.map((t) => `#${t.number}`).join(", ");
      lines.push(`CI awaiting check: ${list}`);
    }
    return lines;
  }

  function appendWorkflowPrPanelLines(
    lines: string[],
    active: ActiveWorkflow,
  ): void {
    if (active.stage === "merged" && active.workflowPr) {
      lines.push(
        `Workflow PR #${active.workflowPr.number}: merged → ${active.workflowPr.baseBranch} (cleanup pending)`,
      );
      return;
    }
    if (active.workflowPr) {
      lines.push(
        `Workflow PR #${active.workflowPr.number}: open → ${active.workflowPr.baseBranch}`,
      );
    }
  }

  async function invokeCreateSpec(
    bound: RootScopedPorts,
  ): Promise<StageResult> {
    const outcome = await bound.skills.runCreateSpec();
    if (!outcome.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-spec",
        reason: outcome.reason,
      };
    }

    if (!isUsableDraft(outcome.draft)) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-spec",
        reason:
          "Create-spec skill returned a draft missing a non-empty title or body. Matt Auto entered Compatibility recovery rather than publishing.",
      };
    }

    const draft: SpecDraft = {
      title: outcome.draft.title.trim(),
      body: outcome.draft.body,
    };
    pending = { stage: "create-spec", draft };
    return {
      status: "needs-confirmation",
      stage: "create-spec",
      draft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    };
  }

  async function invokeCreateTickets(
    bound: RootScopedPorts,
    workflowId: number,
    workflowTitle?: string,
  ): Promise<StageResult> {
    const outcome = await bound.skills.runCreateTickets({
      workflowId,
      ...(workflowTitle ? { title: workflowTitle } : {}),
    });
    if (!outcome.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-tickets",
        reason: outcome.reason,
      };
    }

    const validated = validateTicketsDraft(outcome.draft);
    if (!validated.ok) {
      pending = undefined;
      return {
        status: "compatibility-recovery",
        stage: "create-tickets",
        reason: validated.reason,
      };
    }

    const draft: TicketsDraft = { tickets: validated.tickets };
    pending = {
      stage: "create-tickets",
      draft,
      workflowId,
      ...(workflowTitle ? { workflowTitle } : {}),
    };
    return {
      status: "needs-confirmation",
      stage: "create-tickets",
      draft,
      confirmationOptions: [...STAGE_CONFIRMATION_OPTIONS],
    };
  }

  async function findAvailableModel(
    provider: string,
    modelId: string,
  ): Promise<AvailableModel | undefined> {
    const models = await ports.models.listAvailableModels();
    return models.find(
      (model) => model.provider === provider && model.modelId === modelId,
    );
  }

  async function assertValidWorkerProfile(
    profile: WorkerProfile,
  ): Promise<void> {
    if (
      !profile.provider ||
      !profile.modelId ||
      !profile.thinkingLevel ||
      typeof profile.provider !== "string" ||
      typeof profile.modelId !== "string" ||
      typeof profile.thinkingLevel !== "string"
    ) {
      throw new Error(
        "Worker profile requires provider, modelId, and thinkingLevel.",
      );
    }

    const models = await ports.models.listAvailableModels();
    // Empty catalog (tests / offline) skips catalog validation but still
    // requires a non-empty thinking level string.
    if (models.length === 0) {
      return;
    }

    const match = models.find(
      (model) =>
        model.provider === profile.provider && model.modelId === profile.modelId,
    );
    if (!match) {
      throw new Error(
        `Model "${profile.provider}/${profile.modelId}" is not in Pi’s authenticated available-model catalog.`,
      );
    }
    if (!match.thinkingLevels.includes(profile.thinkingLevel)) {
      throw new Error(
        `Thinking level "${profile.thinkingLevel}" is not supported by ${profile.provider}/${profile.modelId}. Supported: ${match.thinkingLevels.join(", ")}.`,
      );
    }
  }

  // Short-lived preflight cache — menu open calls preflight + nextActions back-to-back.
  let preflightCache:
    | { result: PreflightResult; at: number; rootPath: string }
    | undefined;
  const PREFLIGHT_TTL_MS = 5_000;

  async function preflight(): Promise<PreflightResult> {
    const bound = await requireScoped();
    if (
      preflightCache &&
      preflightCache.rootPath === selectedPath &&
      Date.now() - preflightCache.at < PREFLIGHT_TTL_MS
    ) {
      return preflightCache.result;
    }

    const targetBranch = await resolveTargetBranch(bound.preferences);

    const [
      hasGitHubRemote,
      isGhAuthenticated,
      targetBranchExists,
      installedSkills,
      workerProfile,
    ] = await Promise.all([
      bound.environment.hasGitHubRemote(),
      bound.environment.isGhAuthenticated(),
      bound.environment.targetBranchExists(targetBranch),
      bound.skills.installedSkillNames(),
      resolveWorkerProfile(bound),
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
            ? `Worker profile is set (${workerProfile.profile.provider}/${workerProfile.profile.modelId}, thinking ${workerProfile.profile.thinkingLevel}, source ${workerProfile.source}).`
            : "No Worker profile is configured. Set a global or Workflow-root Worker profile (model + thinking level) before starting Implementation workers.",
      },
    ];

    const result: PreflightResult = {
      ok: checks.every((check) => check.ok),
      targetBranch,
      checks,
    };
    if (workerProfile) {
      result.workerProfile = workerProfile;
    }
    preflightCache = {
      result,
      at: Date.now(),
      rootPath: selectedPath ?? ports.startPath,
    };
    return result;
  }

  async function nextActions(): Promise<NextAction[]> {
    const result = await preflight();
    if (!result.ok) {
      return [];
    }

    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);

    if (!active) {
      const actions: NextAction[] = [
        {
          id: CREATE_SPEC_ACTION.id,
          label: CREATE_SPEC_ACTION.label,
          description: CREATE_SPEC_ACTION.description,
        },
      ];
      const targetBranch = await resolveTargetBranch(bound.preferences);
      if (
        lastCompletedWorkflow &&
        lastCompletedWorkflow.targetBranch === targetBranch
      ) {
        actions.push({
          id: START_FOLLOW_UP_ACTION.id,
          label: START_FOLLOW_UP_ACTION.label,
          description: `${START_FOLLOW_UP_ACTION.description} References completed Workflow #${lastCompletedWorkflow.workflowId}.`,
        });
      }
      return actions;
    }

    if (active.stage === "spec-published") {
      return [
        {
          id: CREATE_TICKETS_ACTION.id,
          label: CREATE_TICKETS_ACTION.label,
          description: CREATE_TICKETS_ACTION.description,
        },
      ];
    }

    if (active.stage === "merged") {
      return [
        {
          id: CLEANUP_WORKFLOW_ACTION.id,
          label: CLEANUP_WORKFLOW_ACTION.label,
          description: CLEANUP_WORKFLOW_ACTION.description,
        },
      ];
    }

    if (isTicketWorkStage(active.stage)) {
      // While a worker runs, the passive panel owns progress.
      if (activeWorker || activeConflictWorker) {
        return [];
      }

      // New /matt-auto run loses in-memory disposition/integration state.
      // Rebuild from transcripts so we Retry Integration / Auto-Close instead
      // of launching another Implement attempt for the same ticket.
      if (!pendingDisposition && !pendingIntegration) {
        await recoverPendingDispositionFromTranscripts(bound, active);
      }

      // After success, offer the Implementation disposition Next action only.
      if (pendingDisposition) {
        return [
          {
            id: dispositionActionId(pendingDisposition.ticketNumber),
            label: `Disposition #${pendingDisposition.ticketNumber}`,
            description:
              pendingDisposition.summary ??
              "Close / Leave open / Investigate after the Implementation worker Stage result.",
          },
        ];
      }

      // Fail-closed Integration unit retry (one ticket at a time).
      if (pendingIntegration) {
        return [
          {
            id: integrateTicketActionId(pendingIntegration.ticketNumber),
            label: `Retry Integration #${pendingIntegration.ticketNumber}`,
            description:
              pendingIntegration.lastFailure ??
              "Retry the serialized Integration unit (merge, Local verification, coordinator push).",
          },
        ];
      }

      const actions: NextAction[] = [];
      if (pendingCiRecovery) {
        const n = pendingCiRecovery.ticketNumber;
        const detail =
          pendingCiRecovery.summary ??
          "CI gate failed. Inspect the run, retry the check, or leave the ticket open.";
        actions.push(
          {
            id: ciRecoveryActionId(n, "inspect"),
            label: `Inspect CI #${n}`,
            description: detail,
          },
          {
            id: ciRecoveryActionId(n, "retry"),
            label: `Retry CI #${n}`,
            description:
              "Re-push the Integration branch if needed and re-run the on-demand CI gate check once.",
          },
          {
            id: ciRecoveryActionId(n, "leave-open"),
            label: `Leave open #${n}`,
            description:
              "Dismiss CI recovery and leave the GitHub ticket open. Check CI remains available later.",
          },
        );
      }

      const progress = await loadTicketProgress(bound, active);
      if (!progress) {
        return actions;
      }

      for (const ticket of progress.awaitingCi) {
        if (pendingCiRecovery?.ticketNumber === ticket.number) continue;
        actions.push({
          id: checkCiActionId(ticket.number),
          label: `Check CI #${ticket.number}`,
          description: `${ticket.title}. On-demand CI gate check — pending returns control immediately; green closes the ticket; red offers recovery.`,
        });
      }

      const now = Date.now();
      actions.push(
        ...progress.ready
          .filter((ticket) => {
            const cooled = implementationRecoveryCooldown.get(ticket.number);
            if (cooled === undefined) return true;
            if (now - cooled >= IMPLEMENTATION_RECOVERY_COOLDOWN_MS) {
              implementationRecoveryCooldown.delete(ticket.number);
              return true;
            }
            return false;
          })
          .map(formatImplementAction),
      );

      // Pre-merge Rework for closed integrated tickets (fresh numbered attempt).
      if (!active.workflowPr || active.stage === "pr-opened") {
        const closedIntegrated = (active.integratedTickets ?? []).filter(
          (t) =>
            !progress.ready.some((r) => r.number === t.number) &&
            !progress.awaitingCi.some((r) => r.number === t.number) &&
            !progress.blocked.some((r) => r.number === t.number),
        );
        // Offer rework only for tickets that are closed on GitHub.
        if (closedIntegrated.length > 0) {
          const closedTickets = await bound.tracker.listTickets(
            closedIntegrated.map((t) => t.number),
          );
          for (const ticket of closedTickets) {
            if (ticket.state !== "CLOSED") continue;
            actions.push({
              id: reworkTicketActionId(ticket.number),
              label: `Rework #${ticket.number}`,
              description: `${ticket.title}. Pre-merge Rework attempt: reopen the ticket and create a fresh numbered Implementation workspace without reusing the completed one.`,
            });
          }
        }
      }

      if (allTicketsComplete(progress)) {
        const integratedCount = active.integratedTickets?.length ?? 0;
        const allIntegrated =
          integratedCount >= progress.total &&
          (active.tickets ?? []).every((n) =>
            (active.integratedTickets ?? []).some((t) => t.number === n),
          );
        if (allIntegrated && active.integrationBranch) {
          if (!active.workflowPr) {
            actions.unshift({
              id: OPEN_WORKFLOW_PR_ACTION.id,
              label: OPEN_WORKFLOW_PR_ACTION.label,
              description: `${OPEN_WORKFLOW_PR_ACTION.description} Target branch: ${active.targetBranch}.`,
            });
          } else if (active.stage === "pr-opened") {
            actions.unshift({
              id: MERGE_WORKFLOW_PR_ACTION.id,
              label: MERGE_WORKFLOW_PR_ACTION.label,
              description: `${MERGE_WORKFLOW_PR_ACTION.description} PR #${active.workflowPr.number} → ${active.workflowPr.baseBranch}.`,
            });
          }
        }
      }

      actions.push(formatTicketProgressAction(progress));
      return actions;
    }

    return [];
  }

  async function runNextAction(actionId: string): Promise<StageResult> {
    if (actionId === CREATE_SPEC_ACTION.id) {
      return startCreateSpec();
    }

    if (actionId === CREATE_TICKETS_ACTION.id) {
      return startCreateTickets();
    }

    if (actionId === TICKET_PROGRESS_ACTION.id) {
      return showTicketProgress();
    }

    const implementTicket = parseImplementTicketActionId(actionId);
    if (implementTicket !== undefined) {
      return startImplementation(implementTicket);
    }

    const dispositionTicket = parseDispositionActionId(actionId);
    if (dispositionTicket !== undefined) {
      return presentPendingDisposition(dispositionTicket);
    }

    const integrateTicket = parseIntegrateTicketActionId(actionId);
    if (integrateTicket !== undefined) {
      return retryIntegration(integrateTicket);
    }

    const checkCiTicket = parseCheckCiActionId(actionId);
    if (checkCiTicket !== undefined) {
      return runCiGateCheck(checkCiTicket, { rePush: false });
    }

    const ciRecovery = parseCiRecoveryActionId(actionId);
    if (ciRecovery !== undefined) {
      return runCiRecovery(ciRecovery.ticketNumber, ciRecovery.decision);
    }

    if (actionId === OPEN_WORKFLOW_PR_ACTION.id) {
      return openWorkflowPr();
    }

    if (actionId === MERGE_WORKFLOW_PR_ACTION.id) {
      return mergeWorkflowPr();
    }

    if (actionId === CLEANUP_WORKFLOW_ACTION.id) {
      return cleanupWorkflow();
    }

    if (actionId === START_FOLLOW_UP_ACTION.id) {
      return startFollowUpWorkflow();
    }

    const reworkTicket = parseReworkTicketActionId(actionId);
    if (reworkTicket !== undefined) {
      return startRework(reworkTicket);
    }

    return {
      status: "failed",
      stage: "create-spec",
      reason: `Unknown Next action "${actionId}".`,
    };
  }

  async function presentPendingDisposition(
    ticketNumber: number,
  ): Promise<StageResult> {
    if (!pendingDisposition || pendingDisposition.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "implement",
        reason: `No pending Implementation disposition for #${ticketNumber}.`,
        ticketNumber,
      };
    }

    const current = pendingDisposition;
    const result: StageResult = {
      status: "needs-disposition",
      stage: "implement",
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
      workerId: current.workerId,
      dispositionOptions: [...IMPLEMENTATION_DISPOSITION_OPTIONS],
    };
    if (current.summary) {
      result.summary = current.summary;
    }
    return result;
  }

  async function startCreateSpec(): Promise<StageResult> {
    const bound = await requireScoped();
    const preflightResult = await preflight();
    if (!preflightResult.ok) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "Workflow preflight is incomplete. Resolve preflight checks before running Create-spec.",
      };
    }

    const active = await loadActiveWorkflow(bound);
    if (active) {
      return {
        status: "failed",
        stage: "create-spec",
        reason: `An Active workflow already exists for Target branch "${active.targetBranch}" (Workflow ID #${active.workflowId}). Create-spec is unavailable until that workflow completes.`,
      };
    }

    if (pending) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "A Stage confirmation is already pending. Choose Publish, Revise, or Cancel before starting Create-spec again.",
      };
    }

    // Planning stage: invoke installed to-spec in Workflow home; never publish here.
    return invokeCreateSpec(bound);
  }

  async function startCreateTickets(): Promise<StageResult> {
    const bound = await requireScoped();
    const preflightResult = await preflight();
    if (!preflightResult.ok) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Workflow preflight is incomplete. Resolve preflight checks before running Create-tickets.",
      };
    }

    const active = await loadActiveWorkflow(bound);
    if (!active) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "No Active workflow exists. Publish Create-spec before running Create-tickets.",
      };
    }

    if (active.stage !== "spec-published") {
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Create-tickets is unavailable while the Active workflow is in stage "${active.stage}".`,
      };
    }

    if (pending) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "A Stage confirmation is already pending. Choose Publish, Revise, or Cancel before starting Create-tickets again.",
      };
    }

    // Planning stage: invoke installed to-tickets in Workflow home; never publish here.
    return invokeCreateTickets(bound, active.workflowId, active.title);
  }

  async function showTicketProgress(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "tickets-published") {
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Ticket progress is available only after Create-tickets has been published for the Active workflow.",
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress) {
      return {
        status: "failed",
        stage: "create-tickets",
        reason: "Could not compute ticket progress from GitHub state.",
      };
    }

    const completed: StageResult = {
      status: "completed",
      stage: "create-tickets",
      workflowId: active.workflowId,
      ticketProgress: progress,
    };
    if (active.tickets) {
      completed.tickets = [...active.tickets];
    }
    return completed;
  }

  async function confirmStage(
    decision: StageConfirmationDecision,
  ): Promise<StageResult> {
    if (!pending) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "No pending Stage confirmation. Run a Planning stage first and wait for a reviewable draft.",
      };
    }

    if (pending.stage === "create-spec") {
      return confirmCreateSpec(decision, pending);
    }

    return confirmCreateTickets(decision, pending);
  }

  async function confirmCreateSpec(
    decision: StageConfirmationDecision,
    current: PendingCreateSpec,
  ): Promise<StageResult> {
    if (decision === "cancel") {
      pending = undefined;
      return {
        status: "cancelled",
        stage: "create-spec",
      };
    }

    const bound = await requireScoped();

    if (decision === "revise") {
      // Re-invoke to-spec without any remote writes.
      pending = undefined;
      return invokeCreateSpec(bound);
    }

    // decision === "publish"
    const draft = current.draft;
    const targetBranch = await resolveTargetBranch(bound.preferences);
    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "create-spec",
        reason:
          "Cannot publish Create-spec without a Worker profile. Configure one and retry Stage confirmation Publish.",
      };
    }

    // Remote writes only on Publish, owned by the Workflow coordinator.
    let issueNumber: number;
    try {
      const created = await bound.tracker.createIssue({
        title: draft.title,
        body: draft.body,
        labels: [SPEC_ISSUE_LABEL],
      });
      issueNumber = created.number;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Failed to create the GitHub spec issue: ${message}`,
      };
    }

    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: issueNumber,
      targetBranch,
      stage: "spec-published",
      workerProfile: workerProfile.profile,
    };

    try {
      await bound.tracker.writeWorkflowManifest(issueNumber, manifest);
    } catch (error) {
      // Issue already exists remotely — drop the session pending draft so a retry
      // cannot create a second spec issue for the same Stage confirmation.
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-spec",
        reason: `Spec issue #${issueNumber} was created, but writing the Workflow manifest failed: ${message}. Inspect issue #${issueNumber} and recover the Workflow manifest before continuing.`,
      };
    }

    // Rebuildable local pointer so later /matt-auto opens do not scan every issue.
    await bound.preferences.setActiveWorkflowId(targetBranch, issueNumber);

    pending = undefined;
    return {
      status: "completed",
      stage: "create-spec",
      workflowId: issueNumber,
    };
  }

  async function confirmCreateTickets(
    decision: StageConfirmationDecision,
    current: PendingCreateTickets,
  ): Promise<StageResult> {
    if (decision === "cancel") {
      pending = undefined;
      return {
        status: "cancelled",
        stage: "create-tickets",
      };
    }

    const bound = await requireScoped();

    if (decision === "revise") {
      pending = undefined;
      return invokeCreateTickets(
        bound,
        current.workflowId,
        current.workflowTitle,
      );
    }

    // decision === "publish"
    const active = await loadActiveWorkflow(bound);
    if (!active || active.workflowId !== current.workflowId) {
      pending = undefined;
      return {
        status: "failed",
        stage: "create-tickets",
        reason:
          "Active workflow changed before Create-tickets publish. Re-run Create-tickets from Next actions.",
      };
    }
    if (active.stage !== "spec-published") {
      pending = undefined;
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Cannot publish Create-tickets while the Active workflow is in stage "${active.stage}".`,
      };
    }

    const ordered = topologicalOrder(current.draft.tickets);
    const localToNumber = new Map<string, number>();
    const localToTitle = new Map(
      current.draft.tickets.map((t) => [t.localId, t.title]),
    );
    const createdNumbers: number[] = [];

    try {
      for (const ticket of ordered) {
        const blockers = ticket.blockedBy.map((localId) => {
          const number = localToNumber.get(localId);
          if (number === undefined) {
            throw new Error(
              `Missing published issue for blocker localId "${localId}".`,
            );
          }
          return {
            number,
            title: localToTitle.get(localId) ?? `#${number}`,
          };
        });

        const body = formatPublishedTicketBody(
          ticket,
          current.workflowId,
          current.workflowTitle ?? active.title,
          blockers,
        );

        const created = await bound.tracker.createIssue({
          title: ticket.title,
          body,
          labels: [TICKET_ISSUE_LABEL],
        });
        localToNumber.set(ticket.localId, created.number);
        createdNumbers.push(created.number);

        await bound.tracker.addSubIssue(current.workflowId, created.number);

        for (const blocker of blockers) {
          await bound.tracker.addBlockedBy(created.number, blocker.number);
        }
      }
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const created =
        createdNumbers.length > 0
          ? ` Created ticket issues: ${createdNumbers.map((n) => `#${n}`).join(", ")}.`
          : "";
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Failed while publishing Create-tickets:${created} ${message}`.trim(),
      };
    }

    const targetBranch = await resolveTargetBranch(bound.preferences);
    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: current.workflowId,
      targetBranch,
      stage: "tickets-published",
      workerProfile: active.workerProfile,
      tickets: createdNumbers,
    };

    try {
      await bound.tracker.writeWorkflowManifest(current.workflowId, manifest);
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "create-tickets",
        reason: `Ticket issues ${createdNumbers.map((n) => `#${n}`).join(", ")} were created, but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${current.workflowId} before continuing.`,
      };
    }

    pending = undefined;

    // Re-read ticket state from GitHub for the frontier snapshot.
    const listed = await bound.tracker.listTickets(createdNumbers);
    const progress = computeTicketProgress(current.workflowId, listed);

    return {
      status: "completed",
      stage: "create-tickets",
      workflowId: current.workflowId,
      tickets: createdNumbers,
      ticketProgress: progress,
    };
  }

  async function getActiveWorkflow(): Promise<ActiveWorkflow | undefined> {
    const bound = await requireScoped();
    return loadActiveWorkflow(bound);
  }

  async function getTicketProgress(): Promise<
    TicketProgressSummary | undefined
  > {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active) return undefined;
    return loadTicketProgress(bound, active);
  }

  async function startImplementation(ticketNumber: number): Promise<StageResult> {
    const bound = await requireScoped();
    const preflightResult = await preflight();
    if (!preflightResult.ok) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Workflow preflight is incomplete. Resolve preflight checks before launching an Implementation worker.",
        ticketNumber,
      };
    }

    if (pending) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "A Stage confirmation is already pending. Finish Create-spec or Create-tickets before launching an Implementation worker.",
        ticketNumber,
      };
    }

    if (pendingDisposition) {
      return {
        status: "failed",
        stage: "implement",
        reason: `An Implementation disposition is pending for #${pendingDisposition.ticketNumber}. Choose Close, Leave open, or Investigate before launching another worker.`,
        ticketNumber,
      };
    }

    if (activeWorker) {
      return {
        status: "failed",
        stage: "implement",
        reason: `An Implementation worker is already running for #${activeWorker.ticketNumber} (r${activeWorker.attempt}). The single-worker path does not launch concurrent workers.`,
        ticketNumber,
      };
    }

    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Implementation workers require an Active workflow with published tickets (pre-merge).",
        ticketNumber,
      };
    }

    const progress = await loadTicketProgress(bound, active);
    const ready = progress?.ready.find((t) => t.number === ticketNumber);
    if (!ready) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Ticket #${ticketNumber} is not on the ready frontier (open with no open blockers).`,
        ticketNumber,
      };
    }

    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Cannot launch an Implementation worker without a Worker profile.",
        ticketNumber,
      };
    }

    const prepared = await bound.skills.prepareImplement({
      ticketNumber,
      title: ready.title,
    });
    if (!prepared.ok) {
      return {
        status: "compatibility-recovery",
        stage: "implement",
        reason: prepared.reason,
        ticketNumber,
      };
    }

    const latest = await bound.workspace.latestAttempt(
      active.workflowId,
      ticketNumber,
    );
    const attempt = latest + 1;
    const targetBranch = await resolveTargetBranch(bound.preferences);
    // Dependents branch from the Integration branch after successful units.
    const baseRef = active.integrationBranch ?? targetBranch;

    let workspace: { branchName: string; worktreePath: string };
    try {
      workspace = await bound.workspace.createImplementationWorkspace({
        workflowId: active.workflowId,
        ticketNumber,
        attempt,
        baseRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "implement",
        reason: `Failed to create Implementation workspace: ${message}`,
        ticketNumber,
        attempt,
      };
    }

    // Expected branch naming is a product rule; surface mismatches fail closed.
    const expectedBranch = implementationBranchName(
      active.workflowId,
      ticketNumber,
      attempt,
    );
    if (workspace.branchName !== expectedBranch) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Implementation workspace branch "${workspace.branchName}" does not match expected "${expectedBranch}".`,
        ticketNumber,
        attempt,
      };
    }

    // Workspaces must live outside the Workflow root (sibling layout).
    const resolvedRoot = path.resolve(selectedPath ?? "");
    const resolvedWorktree = path.resolve(workspace.worktreePath);
    if (
      resolvedWorktree === resolvedRoot ||
      resolvedWorktree.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Implementation workspace must live outside the Workflow root. Received "${workspace.worktreePath}" under "${resolvedRoot}".`,
        ticketNumber,
        attempt,
      };
    }

    const workerId = `implement-${active.workflowId}-${ticketNumber}-r${attempt}`;
    const worker: ActiveImplementationWorker = {
      workerId,
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      status: "running",
      receivedStageResult: false,
    };
    activeWorker = worker;

    const transcriptKey = {
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
    };

    await bound.transcripts.append(transcriptKey, {
      type: "worker-launch",
      workerId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      skillCommand: prepared.skillCommand,
    });

    const sink: WorkerEventSink = {
      onEvent: (event) => handleWorkerEvent(bound, event),
    };

    try {
      const runtime = await bound.workers.launch(
        {
          workerId,
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
          worktreePath: workspace.worktreePath,
          branchName: workspace.branchName,
          workerProfile: workerProfile.profile,
          ticketTitle: ready.title,
          prompt: prepared.prompt,
          skillCommand: prepared.skillCommand,
        },
        sink,
      );
      if (typeof runtime.pid === "number") {
        worker.pid = runtime.pid;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "worker-process",
        workerId,
        pid: runtime.pid,
        alive: runtime.alive,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        transcriptPath: workerTranscriptPath(selectedPath ?? ports.startPath, {
          workflowId: active.workflowId,
          ticketNumber,
          attempt,
        }),
      });
    } catch (error) {
      activeWorker = undefined;
      const message = error instanceof Error ? error.message : String(error);
      await bound.transcripts.append(transcriptKey, {
        type: "worker-launch-failed",
        reason: message,
      });
      return {
        status: "failed",
        stage: "implement",
        reason: `Failed to launch Implementation worker: ${message}`,
        ticketNumber,
        attempt,
      };
    }

    // Successful launch clears recovery cooldown for this ticket.
    implementationRecoveryCooldown.delete(ticketNumber);

    // Workers never touch the issue tracker — only the coordinator does, and
    // launch leaves GitHub recoverable (no issue mutation on start).
    return {
      status: "running",
      stage: "implement",
      workflowId: active.workflowId,
      ticketNumber,
      attempt,
      workerId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
    };
  }

  async function handleWorkerEvent(
    bound: RootScopedPorts,
    event: WorkerProtocolEvent,
  ): Promise<void> {
    if (activeConflictWorker?.workerId === event.workerId) {
      await handleConflictWorkerEvent(bound, event);
      return;
    }

    const worker =
      activeWorker?.workerId === event.workerId
        ? activeWorker
        : pendingDisposition?.workerId === event.workerId
          ? pendingDisposition
          : undefined;
    if (!worker) {
      return;
    }

    const transcriptKey = {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    };
    await bound.transcripts.append(transcriptKey, event);

    if (event.type === "progress") {
      if (activeWorker?.workerId === worker.workerId) {
        worker.progress = event.message;
      }
      return;
    }

    if (event.type === "stage-result") {
      // Stage results only apply to the running worker, not a pending disposition.
      if (activeWorker?.workerId !== worker.workerId) {
        return;
      }
      worker.receivedStageResult = true;
      if (event.outcome.status === "completed") {
        worker.status = "needs-disposition";
        if (event.outcome.summary) {
          worker.summary = event.outcome.summary;
        }
        pendingDisposition = worker;
        activeWorker = undefined;
        return;
      }

      worker.status = "failed";
      activeWorker = undefined;
      return;
    }

    // process-exit
    if (worker.receivedStageResult) {
      // Stage result already settled the attempt; keep disposition if pending.
      return;
    }

    // Fallback: many agents finish with exit 0 + local commits but forget the
    // Stage result JSON. Infer completion so the pipeline can advance.
    // Base must be the Integration branch when present — comparing to main/target
    // falsely counts already-integrated commits as new ticket work.
    if (event.code === 0 || event.code === null) {
      try {
        const active = await loadActiveWorkflow(bound);
        const targetBranch = await resolveTargetBranch(bound.preferences);
        const baseRef =
          active?.integrationBranch && active.integrationBranch.length > 0
            ? active.integrationBranch
            : targetBranch;
        const ahead = await bound.workspace.hasCommitsAhead({
          worktreePath: worker.worktreePath,
          baseRef,
        });
        if (ahead.ahead) {
          worker.receivedStageResult = true;
          worker.status = "needs-disposition";
          worker.summary =
            worker.progress ??
            `Inferred completion: ${ahead.count} commit(s) ahead of ${baseRef}` +
              (ahead.headSha ? ` @ ${ahead.headSha.slice(0, 8)}` : "");
          pendingDisposition = worker;
          if (activeWorker?.workerId === worker.workerId) {
            activeWorker = undefined;
          }
          await bound.transcripts.append(transcriptKey, {
            type: "stage-result-inferred",
            reason:
              "Worker exited without Stage result JSON; inferred completed from local commits ahead of Integration/base.",
            code: event.code,
            headSha: ahead.headSha,
            commitCount: ahead.count,
            baseRef,
          });
          return;
        }
      } catch {
        // Fall through to recovery.
      }
    }

    // Fail closed: agent settled without a Stage result and no local commits.
    worker.status = "compatibility-recovery";
    if (activeWorker?.workerId === worker.workerId) {
      activeWorker = undefined;
    }
    // Cooldown so /matt-auto run does not immediately re-launch the same ticket.
    implementationRecoveryCooldown.set(worker.ticketNumber, Date.now());
    await bound.transcripts.append(transcriptKey, {
      type: "compatibility-recovery",
      reason:
        "Implementation worker process exited without a Stage result on the Worker protocol.",
      code: event.code,
    });
  }

  async function handleConflictWorkerEvent(
    bound: RootScopedPorts,
    event: WorkerProtocolEvent,
  ): Promise<void> {
    const worker = activeConflictWorker;
    if (!worker || worker.workerId !== event.workerId) {
      return;
    }

    const transcriptKey = {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    };
    await bound.transcripts.append(transcriptKey, event);

    if (event.type === "progress") {
      worker.progress = event.message;
      return;
    }

    if (event.type === "stage-result") {
      worker.receivedStageResult = true;
      if (event.outcome.status === "completed") {
        worker.status = "completed";
        activeConflictWorker = undefined;

        const unit = pendingIntegration;
        if (
          !unit ||
          unit.ticketNumber !== worker.ticketNumber ||
          unit.workflowId !== worker.workflowId
        ) {
          return;
        }

        const integrationWorkspace = {
          branchName: worker.integrationBranch,
          worktreePath: worker.integrationWorktreePath,
        };
        delete unit.conflict;
        delete unit.lastFailure;

        await finishIntegrationAfterMerge(bound, unit, integrationWorkspace);
        return;
      }

      worker.status = "failed";
      activeConflictWorker = undefined;
      if (
        pendingIntegration &&
        pendingIntegration.ticketNumber === worker.ticketNumber
      ) {
        pendingIntegration.lastFailure = `Conflict resolution failed: ${event.outcome.reason}`;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "conflict-resolution-failed",
        reason: event.outcome.reason,
      });
      return;
    }

    if (worker.receivedStageResult) {
      return;
    }

    worker.status = "compatibility-recovery";
    activeConflictWorker = undefined;
    const reason =
      "Conflict resolution worker process exited without a Stage result on the Worker protocol. Matt Auto entered Compatibility recovery rather than guessing merges.";
    if (
      pendingIntegration &&
      pendingIntegration.ticketNumber === worker.ticketNumber
    ) {
      pendingIntegration.lastFailure = `Compatibility recovery: ${reason}`;
    }
    await bound.transcripts.append(transcriptKey, {
      type: "compatibility-recovery",
      reason,
      code: event.code,
    });
  }

  async function confirmDisposition(
    decision: ImplementationDispositionDecision,
  ): Promise<StageResult> {
    if (!pendingDisposition) {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "No pending Implementation disposition. Wait for a successful Implementation worker Stage result first.",
      };
    }

    if (
      decision !== "close" &&
      decision !== "leave-open" &&
      decision !== "investigate"
    ) {
      return {
        status: "failed",
        stage: "implement",
        reason: `Unknown Implementation disposition "${String(decision)}".`,
      };
    }

    const current = pendingDisposition;
    const bound = await requireScoped();
    const transcriptKey = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
    };

    await bound.transcripts.append(transcriptKey, {
      type: "disposition",
      decision,
    });

    pendingDisposition = undefined;
    current.status = "completed";

    // Leave open / Investigate: no Integration unit, no remote writes, ticket stays open.
    if (decision !== "close") {
      return {
        status: "completed",
        stage: "implement",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        disposition: decision,
        integrated: false,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    // Close starts a serialized Integration unit; ticket is not closed yet.
    if (pendingIntegration) {
      return {
        status: "failed",
        stage: "integrate",
        reason: `An Integration unit is already pending for #${pendingIntegration.ticketNumber}. Integration units process one completed ticket at a time.`,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
      };
    }

    pendingIntegration = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
    };

    return runIntegrationUnit(bound, pendingIntegration);
  }

  async function retryIntegration(ticketNumber: number): Promise<StageResult> {
    if (!pendingIntegration || pendingIntegration.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "integrate",
        reason: `No pending Integration unit for #${ticketNumber}.`,
        ticketNumber,
      };
    }

    const bound = await requireScoped();
    return runIntegrationUnit(bound, pendingIntegration);
  }

  /**
   * Serialized Integration unit:
   * 1. Ensure Integration workspace (dedicated worktree, not Workflow home)
   * 2. Merge ticket branch into Integration branch (local only)
   * 3. Local verification (project-discoverable checks)
   * 4. Coordinator remote writes (push + Workflow manifest update)
   *
   * Fail closed: no remote advancement on merge or verification failure.
   * Tickets stay open until the CI gate (later ticket).
   */
  async function runIntegrationUnit(
    bound: RootScopedPorts,
    unit: PendingIntegration,
  ): Promise<StageResult> {
    if (integrationInProgress) {
      return {
        status: "failed",
        stage: "integrate",
        reason:
          "An Integration unit is already in progress. Integration units process one completed ticket at a time.",
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    if (activeConflictWorker) {
      return {
        status: "failed",
        stage: "integrate",
        reason: `A Conflict resolution worker is already running for #${activeConflictWorker.ticketNumber}.`,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    if (unit.conflict) {
      return launchConflictWorker(bound, unit, unit.conflict);
    }

    integrationInProgress = true;
    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };

    try {
      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-start",
        ticketBranch: unit.branchName,
      });

      const active = await loadActiveWorkflow(bound);
      if (!active || active.workflowId !== unit.workflowId) {
        const reason =
          "No Active workflow matches this Integration unit. Recover Workflow state before retrying.";
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Already integrated (e.g. recovered from manifest) — do not re-merge.
      if (active.integratedTickets?.some((t) => t.number === unit.ticketNumber)) {
        pendingIntegration = undefined;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-skipped",
          reason: "Ticket already recorded as integrated on the Workflow manifest.",
        });
        return {
          status: "completed",
          stage: "integrate",
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          disposition: "close",
          integrated: true,
          integrationBranch:
            active.integrationBranch ?? integrationBranchName(unit.workflowId),
          branchName: unit.branchName,
          worktreePath: unit.worktreePath,
        };
      }

      const targetBranch = await resolveTargetBranch(bound.preferences);
      const expectedIntegrationBranch = integrationBranchName(unit.workflowId);

      let integrationWorkspace: { branchName: string; worktreePath: string };
      try {
        integrationWorkspace = await bound.workspace.ensureIntegrationWorkspace({
          workflowId: unit.workflowId,
          baseRef: active.integrationBranch ?? targetBranch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Failed to create Integration workspace: ${message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      if (integrationWorkspace.branchName !== expectedIntegrationBranch) {
        const reason = `Integration workspace branch "${integrationWorkspace.branchName}" does not match expected "${expectedIntegrationBranch}".`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Integration workspace must live outside the Workflow root.
      const resolvedRoot = path.resolve(selectedPath ?? "");
      const resolvedIntegration = path.resolve(integrationWorkspace.worktreePath);
      if (
        resolvedIntegration === resolvedRoot ||
        resolvedIntegration.startsWith(`${resolvedRoot}${path.sep}`)
      ) {
        const reason = `Integration workspace must live outside the Workflow root. Received "${integrationWorkspace.worktreePath}" under "${resolvedRoot}".`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Local merge only — no push yet.
      const mergeResult = await bound.workspace.mergeIntoIntegration({
        workflowId: unit.workflowId,
        ticketBranch: unit.branchName,
      });
      if (!mergeResult.ok) {
        if (mergeResult.reason === "conflict") {
          const conflict = {
            integrationBranch: expectedIntegrationBranch,
            integrationWorktreePath: integrationWorkspace.worktreePath,
            message: mergeResult.message,
          };
          unit.conflict = conflict;
          unit.lastFailure = `Merge conflict integrating ${unit.branchName} into ${expectedIntegrationBranch}: ${mergeResult.message}`;
          await bound.transcripts.append(transcriptKey, {
            type: "integration-unit-conflict",
            reason: unit.lastFailure,
            phase: "merge",
          });
          integrationInProgress = false;
          return launchConflictWorker(bound, unit, conflict);
        }

        const reason = `Failed to merge ${unit.branchName} into ${expectedIntegrationBranch}: ${mergeResult.message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "merge",
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-merged",
        integrationBranch: expectedIntegrationBranch,
        mergeCommitSha: mergeResult.mergeCommitSha,
      });

      return finishIntegrationAfterMerge(bound, unit, integrationWorkspace);
    } finally {
      integrationInProgress = false;
    }
  }


  async function launchConflictWorker(
    bound: RootScopedPorts,
    unit: PendingIntegration,
    conflict: {
      integrationBranch: string;
      integrationWorktreePath: string;
      message: string;
    },
  ): Promise<StageResult> {
    unit.conflict = conflict;

    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };

    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      const reason =
        "Cannot launch a Conflict resolution worker without a Worker profile.";
      unit.lastFailure = reason;
      return {
        status: "failed",
        stage: "integrate",
        reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    const prepared = await bound.skills.prepareResolveConflicts({
      ticketNumber: unit.ticketNumber,
      ticketBranch: unit.branchName,
      integrationBranch: conflict.integrationBranch,
    });
    if (!prepared.ok) {
      unit.lastFailure = prepared.reason;
      return {
        status: "compatibility-recovery",
        stage: "integrate",
        reason: prepared.reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    const workerId = `conflict-${unit.workflowId}-${unit.ticketNumber}-r${unit.attempt}`;
    const worker: ActiveConflictWorker = {
      workerId,
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      status: "running",
      receivedStageResult: false,
    };
    activeConflictWorker = worker;

    await bound.transcripts.append(transcriptKey, {
      type: "conflict-resolution-launch",
      workerId,
      skillCommand: prepared.skillCommand,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      message: conflict.message,
    });

    const sink: WorkerEventSink = {
      onEvent: (event) => handleWorkerEvent(bound, event),
    };

    try {
      const runtime = await bound.workers.launch(
        {
          workerId,
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
          worktreePath: conflict.integrationWorktreePath,
          branchName: conflict.integrationBranch,
          workerProfile: workerProfile.profile,
          ticketTitle: `Conflict resolution for #${unit.ticketNumber}`,
          prompt: prepared.prompt,
          skillCommand: prepared.skillCommand,
        },
        sink,
      );
      if (typeof runtime.pid === "number") {
        worker.pid = runtime.pid;
      }
      await bound.transcripts.append(transcriptKey, {
        type: "worker-process",
        workerId,
        pid: runtime.pid,
        alive: runtime.alive,
        worktreePath: conflict.integrationWorktreePath,
        branchName: conflict.integrationBranch,
        transcriptPath: workerTranscriptPath(selectedPath ?? ports.startPath, {
          workflowId: unit.workflowId,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        }),
      });
    } catch (error) {
      activeConflictWorker = undefined;
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Failed to launch Conflict resolution worker: ${message}`;
      unit.lastFailure = reason;
      await bound.transcripts.append(transcriptKey, {
        type: "conflict-resolution-launch-failed",
        reason,
      });
      return {
        status: "failed",
        stage: "integrate",
        reason,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
      };
    }

    return {
      status: "running",
      stage: "integrate",
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
      workerId,
      integrationBranch: conflict.integrationBranch,
      integrationWorktreePath: conflict.integrationWorktreePath,
      conflictResolution: true,
    };
  }

  async function finishIntegrationAfterMerge(
    bound: RootScopedPorts,
    unit: PendingIntegration,
    integrationWorkspace: { branchName: string; worktreePath: string },
  ): Promise<StageResult> {
    const heldGuard = !integrationInProgress;
    if (heldGuard) {
      integrationInProgress = true;
    }

    const transcriptKey = {
      workflowId: unit.workflowId,
      ticketNumber: unit.ticketNumber,
      attempt: unit.attempt,
    };

    try {
      const active = await loadActiveWorkflow(bound);
      if (!active || active.workflowId !== unit.workflowId) {
        const reason =
          "No Active workflow matches this Integration unit. Recover Workflow state before retrying.";
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      // Local verification before any remote write.
      const verification = await bound.verification.runLocalVerification(
        integrationWorkspace.worktreePath,
      );
      if (!verification.ok) {
        const reason = `Local verification failed in the Integration workspace: ${verification.reason}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "local-verification",
          commands: verification.commands,
        });
        // Fail closed: no push, no manifest update.
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      await bound.transcripts.append(transcriptKey, {
        type: "local-verification",
        commands: verification.commands,
      });

      // Coordinator-only remote writes: push Integration + ticket branches.
      const pushedBranches: string[] = [];
      try {
        await bound.remoteGit.pushBranch(integrationWorkspace.branchName);
        pushedBranches.push(integrationWorkspace.branchName);
        await bound.remoteGit.pushBranch(unit.branchName);
        pushedBranches.push(unit.branchName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Coordinator remote push failed after Local verification: ${message}`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "push",
          pushedBranches,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      const integratedTickets = [
        ...(active.integratedTickets ?? []),
        {
          number: unit.ticketNumber,
          attempt: unit.attempt,
          branchName: unit.branchName,
        },
      ];

      const manifest = manifestFromActive(active, {
        integrationBranch: integrationWorkspace.branchName,
        integratedTickets,
      });

      try {
        await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `Pushed ${pushedBranches.join(", ")} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId} before continuing.`;
        unit.lastFailure = reason;
        await bound.transcripts.append(transcriptKey, {
          type: "integration-unit-failed",
          reason,
          phase: "manifest",
          pushedBranches,
        });
        return {
          status: "failed",
          stage: "integrate",
          reason,
          ticketNumber: unit.ticketNumber,
          attempt: unit.attempt,
        };
      }

      pendingIntegration = undefined;

      await bound.transcripts.append(transcriptKey, {
        type: "integration-unit-completed",
        integrationBranch: integrationWorkspace.branchName,
        pushedBranches,
      });

      // On-demand CI gate once after push — never poll. Pending returns control immediately.
      return applyCiGate(bound, {
        workflowId: unit.workflowId,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
        branchName: unit.branchName,
        worktreePath: unit.worktreePath,
        integrationBranch: integrationWorkspace.branchName,
        integrationWorktreePath: integrationWorkspace.worktreePath,
        localVerification: {
          ok: true,
          commands: verification.commands,
        },
        pushedBranches,
        rePush: false,
      });
    } finally {
      if (heldGuard) {
        integrationInProgress = false;
      }
    }
  }

  async function applyCiGate(
    bound: RootScopedPorts,
    input: {
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      branchName: string;
      worktreePath: string;
      integrationBranch: string;
      integrationWorktreePath?: string;
      localVerification?: { ok: true; commands: readonly string[] };
      pushedBranches?: readonly string[];
      rePush: boolean;
    },
  ): Promise<StageResult> {
    const transcriptKey = {
      workflowId: input.workflowId,
      ticketNumber: input.ticketNumber,
      attempt: input.attempt,
    };

    if (input.rePush) {
      try {
        await bound.remoteGit.pushBranch(input.integrationBranch);
        await bound.transcripts.append(transcriptKey, {
          type: "ci-retry-push",
          branchName: input.integrationBranch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `CI retry push of ${input.integrationBranch} failed: ${message}`;
        pendingCiRecovery = {
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          integrationBranch: input.integrationBranch,
          summary: reason,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "ci-check",
          status: "failure",
          summary: reason,
        });
        return {
          status: "needs-ci-recovery",
          stage: "ci-gate",
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          integrationBranch: input.integrationBranch,
          integrated: true,
          ciStatus: "failure",
          ticketClosed: false,
          recoveryOptions: [...CI_RECOVERY_OPTIONS],
          ciSummary: reason,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
        };
      }
    }

    const ci = await bound.ci.checkStatus({
      branchName: input.integrationBranch,
    });

    await bound.transcripts.append(transcriptKey, {
      type: "ci-check",
      status: ci.status,
      url: ci.url,
      summary: ci.summary,
    });

    if (ci.status === "success") {
      try {
        await bound.tracker.closeIssue(input.ticketNumber);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `CI is green but closing #${input.ticketNumber} failed: ${message}`;
        pendingCiRecovery = {
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
          integrationBranch: input.integrationBranch,
          ...(ci.url ? { url: ci.url } : {}),
          summary: reason,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "ticket-close-failed",
          reason,
        });
        return {
          status: "needs-ci-recovery",
          stage: "ci-gate",
          workflowId: input.workflowId,
          ticketNumber: input.ticketNumber,
          attempt: input.attempt,
          integrationBranch: input.integrationBranch,
          integrated: true,
          ciStatus: "failure",
          ticketClosed: false,
          recoveryOptions: [...CI_RECOVERY_OPTIONS],
          ...(ci.url ? { ciUrl: ci.url } : {}),
          ciSummary: reason,
          branchName: input.branchName,
          worktreePath: input.worktreePath,
        };
      }

      pendingCiRecovery = undefined;
      await bound.transcripts.append(transcriptKey, {
        type: "ticket-closed",
        ticketNumber: input.ticketNumber,
      });

      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        disposition: "close",
        integrated: true,
        integrationBranch: input.integrationBranch,
        ...(input.integrationWorktreePath
          ? { integrationWorktreePath: input.integrationWorktreePath }
          : {}),
        ...(input.localVerification
          ? { localVerification: input.localVerification }
          : {}),
        ...(input.pushedBranches ? { pushedBranches: input.pushedBranches } : {}),
        ciStatus: "success",
        ticketClosed: true,
        ...(ci.url ? { ciUrl: ci.url } : {}),
        ...(ci.summary ? { ciSummary: ci.summary } : {}),
        branchName: input.branchName,
        worktreePath: input.worktreePath,
      };
    }

    if (ci.status === "failure") {
      pendingCiRecovery = {
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        branchName: input.branchName,
        worktreePath: input.worktreePath,
        integrationBranch: input.integrationBranch,
        ...(ci.url ? { url: ci.url } : {}),
        ...(ci.summary ? { summary: ci.summary } : {}),
      };
      return {
        status: "needs-ci-recovery",
        stage: "ci-gate",
        workflowId: input.workflowId,
        ticketNumber: input.ticketNumber,
        attempt: input.attempt,
        integrationBranch: input.integrationBranch,
        integrated: true,
        ciStatus: "failure",
        ticketClosed: false,
        recoveryOptions: [...CI_RECOVERY_OPTIONS],
        ...(ci.url ? { ciUrl: ci.url } : {}),
        ...(ci.summary ? { ciSummary: ci.summary } : {}),
        branchName: input.branchName,
        worktreePath: input.worktreePath,
      };
    }

    pendingCiRecovery = undefined;
    return {
      status: "pending-ci",
      stage: "ci-gate",
      workflowId: input.workflowId,
      ticketNumber: input.ticketNumber,
      attempt: input.attempt,
      integrationBranch: input.integrationBranch,
      integrated: true,
      ciStatus: "pending",
      ticketClosed: false,
      ...(input.integrationWorktreePath
        ? { integrationWorktreePath: input.integrationWorktreePath }
        : {}),
      ...(input.localVerification
        ? { localVerification: input.localVerification }
        : {}),
      ...(input.pushedBranches ? { pushedBranches: input.pushedBranches } : {}),
      ...(ci.url ? { ciUrl: ci.url } : {}),
      ...(ci.summary ? { ciSummary: ci.summary } : {}),
      branchName: input.branchName,
      worktreePath: input.worktreePath,
    };
  }

  async function resolveIntegratedTicket(
    bound: RootScopedPorts,
    ticketNumber: number,
  ): Promise<
    | {
        ok: true;
        active: ActiveWorkflow;
        integrated: IntegratedTicketRef;
        integrationBranch: string;
      }
    | { ok: false; reason: string }
  > {
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        ok: false,
        reason:
          "No Active workflow with published tickets. Recover Workflow state before checking CI.",
      };
    }
    const integrated = active.integratedTickets?.find(
      (t) => t.number === ticketNumber,
    );
    if (!integrated) {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} is not recorded as integrated on the Workflow manifest.`,
      };
    }
    const tickets = await bound.tracker.listTickets([ticketNumber]);
    const ticket = tickets.find((t) => t.number === ticketNumber);
    if (!ticket) {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} was not found on GitHub.`,
      };
    }
    if (ticket.state === "CLOSED") {
      return {
        ok: false,
        reason: `Ticket #${ticketNumber} is already closed.`,
      };
    }
    const integrationBranch =
      active.integrationBranch ?? integrationBranchName(active.workflowId);
    return { ok: true, active, integrated, integrationBranch };
  }

  async function runCiGateCheck(
    ticketNumber: number,
    options: { rePush: boolean },
  ): Promise<StageResult> {
    const bound = await requireScoped();
    const resolved = await resolveIntegratedTicket(bound, ticketNumber);
    if (!resolved.ok) {
      return {
        status: "failed",
        stage: "ci-gate",
        reason: resolved.reason,
        ticketNumber,
      };
    }

    return applyCiGate(bound, {
      workflowId: resolved.active.workflowId,
      ticketNumber,
      attempt: resolved.integrated.attempt,
      branchName: resolved.integrated.branchName,
      worktreePath: "",
      integrationBranch: resolved.integrationBranch,
      rePush: options.rePush,
    });
  }

  async function runCiRecovery(
    ticketNumber: number,
    decision: CiRecoveryDecision,
  ): Promise<StageResult> {
    if (!pendingCiRecovery || pendingCiRecovery.ticketNumber !== ticketNumber) {
      return {
        status: "failed",
        stage: "ci-gate",
        reason: `No pending CI recovery for #${ticketNumber}. Run Check CI first.`,
        ticketNumber,
      };
    }

    const current = pendingCiRecovery;
    const bound = await requireScoped();
    const transcriptKey = {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
    };

    if (decision === "inspect") {
      await bound.transcripts.append(transcriptKey, {
        type: "ci-recovery",
        decision: "inspect",
        url: current.url,
        summary: current.summary,
      });
      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        integrated: true,
        integrationBranch: current.integrationBranch,
        ciStatus: "failure",
        ticketClosed: false,
        ...(current.url ? { ciUrl: current.url } : {}),
        ciSummary:
          current.summary ??
          current.url ??
          `CI failed for #${current.ticketNumber} on ${current.integrationBranch}.`,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    if (decision === "leave-open") {
      pendingCiRecovery = undefined;
      await bound.transcripts.append(transcriptKey, {
        type: "ci-recovery",
        decision: "leave-open",
      });
      return {
        status: "completed",
        stage: "ci-gate",
        workflowId: current.workflowId,
        ticketNumber: current.ticketNumber,
        attempt: current.attempt,
        disposition: "leave-open",
        integrated: true,
        integrationBranch: current.integrationBranch,
        ciStatus: "failure",
        ticketClosed: false,
        branchName: current.branchName,
        worktreePath: current.worktreePath,
      };
    }

    await bound.transcripts.append(transcriptKey, {
      type: "ci-recovery",
      decision: "retry",
    });
    return applyCiGate(bound, {
      workflowId: current.workflowId,
      ticketNumber: current.ticketNumber,
      attempt: current.attempt,
      branchName: current.branchName,
      worktreePath: current.worktreePath,
      integrationBranch: current.integrationBranch,
      rePush: true,
    });
  }

  async function openWorkflowPr(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Open Workflow PR requires an Active workflow with published tickets that are all CI-complete.",
      };
    }
    if (active.workflowPr) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Workflow PR #${active.workflowPr.number} is already open. Use Merge Workflow PR.`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url ? { workflowPrUrl: active.workflowPr.url } : {}),
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress || !allTicketsComplete(progress)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "A Workflow PR is offered only after all tickets are integrated and CI-complete.",
        workflowId: active.workflowId,
      };
    }

    const ticketNumbers = active.tickets ?? [];
    const integrated = active.integratedTickets ?? [];
    const allIntegrated = ticketNumbers.every((n) =>
      integrated.some((t) => t.number === n),
    );
    if (!allIntegrated || !active.integrationBranch) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Cannot open a Workflow PR until every ticket has a successful Integration unit recorded on the Workflow manifest.",
        workflowId: active.workflowId,
      };
    }

    const head = active.integrationBranch;
    const base = active.targetBranch;
    const title =
      active.title?.trim()
        ? `Workflow #${active.workflowId}: ${active.title.trim()}`
        : `Workflow #${active.workflowId}`;
    const body = [
      `Matt Auto Workflow PR for Workflow ID #${active.workflowId}.`,
      "",
      `Integration branch: \`${head}\``,
      `Target branch: \`${base}\``,
      "",
      "Tickets:",
      ...ticketNumbers.map((n) => `- #${n}`),
      "",
      "Opened by Matt Auto after all tickets integrated and CI-complete.",
    ].join("\n");

    let pr: { number: number; url?: string };
    try {
      pr = await bound.tracker.createPullRequest({
        head,
        base,
        title,
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Failed to open Workflow PR from ${head} to ${base}: ${message}`,
        workflowId: active.workflowId,
        integrationBranch: head,
        targetBranch: base,
      };
    }

    const workflowPr = {
      number: pr.number,
      headBranch: head,
      baseBranch: base,
      ...(pr.url ? { url: pr.url } : {}),
    };
    const manifest = manifestFromActive(active, {
      stage: "pr-opened",
      workflowPr,
    });

    try {
      await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Opened Workflow PR #${pr.number} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId}.`,
        workflowId: active.workflowId,
        workflowPrNumber: pr.number,
        ...(pr.url ? { workflowPrUrl: pr.url } : {}),
        integrationBranch: head,
        targetBranch: base,
      };
    }

    return {
      status: "completed",
      stage: "workflow-pr",
      workflowId: active.workflowId,
      workflowPrNumber: pr.number,
      ...(pr.url ? { workflowPrUrl: pr.url } : {}),
      integrationBranch: head,
      targetBranch: base,
    };
  }

  async function mergeWorkflowPr(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "pr-opened" || !active.workflowPr) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Merge Workflow PR requires an open Workflow PR on the Active workflow.",
      };
    }

    const progress = await loadTicketProgress(bound, active);
    if (!progress || !allTicketsComplete(progress)) {
      return {
        status: "failed",
        stage: "workflow-pr",
        reason:
          "Cannot merge the Workflow PR while tickets remain open or awaiting CI. Finish or Rework tickets first.",
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
      };
    }

    try {
      await bound.tracker.mergePullRequest({
        number: active.workflowPr.number,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Failed to merge Workflow PR #${active.workflowPr.number}: ${message}`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    const manifest = manifestFromActive(active, { stage: "merged" });
    try {
      await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "workflow-pr",
        reason: `Merged Workflow PR #${active.workflowPr.number} but writing the Workflow manifest failed: ${message}. Recover the Workflow manifest on #${active.workflowId} before cleanup.`,
        workflowId: active.workflowId,
        workflowPrNumber: active.workflowPr.number,
        ...(active.workflowPr.url
          ? { workflowPrUrl: active.workflowPr.url }
          : {}),
      };
    }

    return {
      status: "completed",
      stage: "workflow-pr",
      workflowId: active.workflowId,
      workflowPrNumber: active.workflowPr.number,
      ...(active.workflowPr.url
        ? { workflowPrUrl: active.workflowPr.url }
        : {}),
      ...(active.integrationBranch
        ? { integrationBranch: active.integrationBranch }
        : {}),
      targetBranch: active.targetBranch,
    };
  }

  async function cleanupWorkflow(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || active.stage !== "merged") {
      return {
        status: "failed",
        stage: "cleanup",
        reason:
          "Workflow cleanup runs after the Workflow PR merges. Merge the Workflow PR first.",
      };
    }

    const branches = await bound.workspace.listWorkflowBranches(
      active.workflowId,
    );

    let removedLocalBranches: readonly string[] = [];
    try {
      const local = await bound.workspace.cleanupWorkflowWorkspaces(
        active.workflowId,
      );
      removedLocalBranches = local.removedLocalBranches;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Local workspace cleanup failed: ${message}`,
        workflowId: active.workflowId,
      };
    }

    // Pair remote cleanup with local — same branch set (local list + any already-known).
    const remoteBranches = [
      ...new Set([
        ...branches,
        ...removedLocalBranches,
        ...(active.integrationBranch ? [active.integrationBranch] : []),
        ...(active.integratedTickets ?? []).map((t) => t.branchName),
      ]),
    ].sort();

    try {
      await bound.remoteGit.deleteRemoteBranches(remoteBranches);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Remote matt-auto branch cleanup failed after local cleanup: ${message}. Retry Cleanup to finish paired remote removal.`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: false,
      };
    }

    try {
      await bound.transcripts.cleanupWorkflowTranscripts(active.workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Transcript cleanup failed after local/remote branch cleanup: ${message}`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: true,
      };
    }

    // Retain GitHub issue/PR/manifest history — only mark completed.
    const manifest = manifestFromActive(active, { stage: "completed" });
    try {
      await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "cleanup",
        reason: `Cleaned local/remote artifacts but writing the completed Workflow manifest failed: ${message}`,
        workflowId: active.workflowId,
        removedBranches: remoteBranches,
        cleanedLocal: true,
        cleanedRemote: true,
      };
    }

    lastCompletedWorkflow = {
      workflowId: active.workflowId,
      targetBranch: active.targetBranch,
      ...(active.title ? { title: active.title } : {}),
    };
    await bound.preferences.clearActiveWorkflowId(active.targetBranch);

    return {
      status: "completed",
      stage: "cleanup",
      workflowId: active.workflowId,
      removedBranches: remoteBranches,
      cleanedLocal: true,
      cleanedRemote: true,
      ...(active.workflowPr
        ? {
            workflowPrNumber: active.workflowPr.number,
            ...(active.workflowPr.url
              ? { workflowPrUrl: active.workflowPr.url }
              : {}),
          }
        : {}),
      targetBranch: active.targetBranch,
      ...(active.integrationBranch
        ? { integrationBranch: active.integrationBranch }
        : {}),
    };
  }

  async function startFollowUpWorkflow(): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (active) {
      return {
        status: "failed",
        stage: "follow-up",
        reason: `An Active workflow already exists for Target branch "${active.targetBranch}" (Workflow ID #${active.workflowId}). Finish or clean it up before starting a Follow-up workflow.`,
      };
    }

    const targetBranch = await resolveTargetBranch(bound.preferences);
    if (
      !lastCompletedWorkflow ||
      lastCompletedWorkflow.targetBranch !== targetBranch
    ) {
      return {
        status: "failed",
        stage: "follow-up",
        reason:
          "Start Follow-up workflow requires a completed Workflow on this Target branch (after Workflow PR merge and cleanup).",
      };
    }

    const original = lastCompletedWorkflow;
    const workerProfile = await resolveWorkerProfile(bound);
    if (!workerProfile) {
      return {
        status: "failed",
        stage: "follow-up",
        reason:
          "Cannot start a Follow-up workflow without a Worker profile. Configure a Worker profile first.",
      };
    }

    const title = original.title?.trim()
      ? `Follow-up: ${original.title.trim()}`
      : `Follow-up of Workflow #${original.workflowId}`;
    const body = [
      `## Follow-up workflow`,
      "",
      `This Follow-up workflow references completed Workflow #${original.workflowId} rather than mutating it.`,
      "",
      `Original Workflow ID: #${original.workflowId}`,
      `Target branch: \`${original.targetBranch}\``,
      "",
      "## What to build",
      "",
      "Describe the post-merge rework for this Follow-up workflow.",
    ].join("\n");

    let created: { number: number };
    try {
      created = await bound.tracker.createIssue({
        title,
        body,
        labels: [SPEC_ISSUE_LABEL],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "follow-up",
        reason: `Failed to create Follow-up spec issue: ${message}`,
        followUpOf: original.workflowId,
      };
    }

    const manifest: WorkflowManifest = {
      schema: WORKFLOW_MANIFEST_SCHEMA,
      version: 1,
      workflowId: created.number,
      targetBranch,
      stage: "spec-published",
      workerProfile: workerProfile.profile,
      followUpOf: original.workflowId,
    };

    try {
      await bound.tracker.writeWorkflowManifest(created.number, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "follow-up",
        reason: `Created Follow-up issue #${created.number} but writing the Workflow manifest failed: ${message}`,
        workflowId: created.number,
        followUpOf: original.workflowId,
      };
    }

    // One Active workflow per Target branch — clear the completed pointer once followed up.
    lastCompletedWorkflow = undefined;

    return {
      status: "completed",
      stage: "follow-up",
      workflowId: created.number,
      followUpOf: original.workflowId,
      targetBranch,
    };
  }

  async function startRework(ticketNumber: number): Promise<StageResult> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active || !isTicketWorkStage(active.stage)) {
      return {
        status: "failed",
        stage: "rework",
        reason:
          "Pre-merge Rework requires an Active workflow before the Workflow PR merges.",
        ticketNumber,
      };
    }

    if (active.stage === "merged") {
      return {
        status: "failed",
        stage: "rework",
        reason:
          "Post-merge rework creates a Follow-up workflow with a new spec issue rather than mutating the completed workflow.",
        ticketNumber,
      };
    }

    const integrated = (active.integratedTickets ?? []).find(
      (t) => t.number === ticketNumber,
    );
    if (!integrated) {
      return {
        status: "failed",
        stage: "rework",
        reason: `Ticket #${ticketNumber} is not recorded as integrated. Use Implement for open ready tickets, or complete Integration first.`,
        ticketNumber,
      };
    }

    const tickets = await bound.tracker.listTickets([ticketNumber]);
    const ticket = tickets.find((t) => t.number === ticketNumber);
    if (!ticket) {
      return {
        status: "failed",
        stage: "rework",
        reason: `Ticket #${ticketNumber} was not found on GitHub.`,
        ticketNumber,
      };
    }

    if (ticket.state === "CLOSED") {
      try {
        await bound.tracker.reopenIssue(ticketNumber);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          stage: "rework",
          reason: `Failed to reopen #${ticketNumber} for Rework: ${message}`,
          ticketNumber,
        };
      }
    }

    // Drop from integrated list so the frontier and Workflow PR gates re-evaluate.
    const remainingIntegrated = (active.integratedTickets ?? []).filter(
      (t) => t.number !== ticketNumber,
    );
    const manifest = manifestFromActive(active, {
      // Keep pr-opened if a Workflow PR already exists; otherwise stay on tickets-published.
      stage: active.workflowPr ? "pr-opened" : "tickets-published",
      integratedTickets: remainingIntegrated,
    });

    try {
      await bound.tracker.writeWorkflowManifest(active.workflowId, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        stage: "rework",
        reason: `Reopened #${ticketNumber} but updating the Workflow manifest failed: ${message}`,
        ticketNumber,
        workflowId: active.workflowId,
      };
    }

    // Fresh numbered attempt workspace + Implementation worker (does not reuse completed workspace).
    return startImplementation(ticketNumber);
  }

  /**
   * Abort session-owned Implementation + Conflict resolution workers.
   * @param setCooldown - when true (session teardown), block auto re-launch briefly.
   * @param transcriptEvent - structured event appended to each affected attempt.
   */
  async function abortSessionWorkers(options: {
    setCooldown: boolean;
    transcriptEvent: Record<string, unknown>;
    preservePendingIntegrationMessage?: string;
  }): Promise<PipelineAffectedAttempt[]> {
    const bound = scoped ?? (await requireScoped());
    const worker = activeWorker;
    const conflictWorker = activeConflictWorker;
    const affected: PipelineAffectedAttempt[] = [];

    if (worker) {
      affected.push({
        workflowId: worker.workflowId,
        ticketNumber: worker.ticketNumber,
        attempt: worker.attempt,
        kind: "implementation",
      });
    }
    if (conflictWorker) {
      affected.push({
        workflowId: conflictWorker.workflowId,
        ticketNumber: conflictWorker.ticketNumber,
        attempt: conflictWorker.attempt,
        kind: "conflict-resolution",
      });
    }

    try {
      await bound.workers.abortAll();
    } catch {
      // Best-effort abort; session teardown still clears local worker state.
    }

    if (worker) {
      worker.status = "aborted";
      if (options.setCooldown) {
        // Prevent the pipeline from immediately re-selecting the same ticket.
        implementationRecoveryCooldown.set(worker.ticketNumber, Date.now());
      }
      await bound.transcripts.append(
        {
          workflowId: worker.workflowId,
          ticketNumber: worker.ticketNumber,
          attempt: worker.attempt,
        },
        options.transcriptEvent,
      );
    }

    if (conflictWorker) {
      conflictWorker.status = "aborted";
      await bound.transcripts.append(
        {
          workflowId: conflictWorker.workflowId,
          ticketNumber: conflictWorker.ticketNumber,
          attempt: conflictWorker.attempt,
        },
        options.transcriptEvent,
      );
      if (
        pendingIntegration &&
        pendingIntegration.ticketNumber === conflictWorker.ticketNumber
      ) {
        pendingIntegration.lastFailure =
          options.preservePendingIntegrationMessage ??
          "Conflict resolution worker aborted with Workflow home. In-progress merge is preserved for retry.";
      }
    }

    activeWorker = undefined;
    activeConflictWorker = undefined;
    return affected;
  }

  async function abortWorkers(): Promise<void> {
    await abortSessionWorkers({
      setCooldown: true,
      transcriptEvent: { type: "worker-aborted" },
    });
  }

  function isPipelinePaused(): boolean {
    return pipelinePaused;
  }

  function isRunTerminated(): boolean {
    return runTerminated;
  }

  function isAutoAdvanceBlocked(): boolean {
    return pipelinePaused || runTerminated;
  }

  function beginPipelineRun(): void {
    pipelinePaused = false;
    runTerminated = false;
    lastStopReason = undefined;
    lastTerminationMode = undefined;
  }

  async function pausePipeline(): Promise<PipelinePauseResult> {
    const affectedAttempts = await abortSessionWorkers({
      setCooldown: false,
      transcriptEvent: {
        type: "pipeline:pause",
        reason: "pipeline-pause",
      },
      preservePendingIntegrationMessage:
        "Conflict resolution worker aborted by Pipeline pause. In-progress merge is preserved for retry.",
    });

    pipelinePaused = true;
    runTerminated = false;
    lastStopReason = "pipeline-pause";
    lastTerminationMode = undefined;

    return {
      abortedWorkerCount: affectedAttempts.length,
      affectedAttempts,
      pipelinePaused: true,
    };
  }

  async function resumePipeline(): Promise<PipelineResumeResult> {
    pipelinePaused = false;
    if (lastStopReason === "pipeline-pause") {
      lastStopReason = undefined;
    }
    // Resume never clears Run termination — that ends the run deliberately.
    return { pipelinePaused: false };
  }

  function resolveTerminationMode(
    active: ActiveWorkflow | undefined,
  ): RunTerminationMode {
    const hasIntegrated =
      (active?.integratedTickets?.length ?? 0) > 0 || Boolean(active?.workflowPr);
    return hasIntegrated ? "stop-only" : "discard-unintegrated";
  }

  /**
   * Collect local unintegrated attempt / integration branches for T2 discard.
   * Never includes branches recorded on integratedTickets.
   */
  async function collectUnintegratedBranches(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<string[]> {
    const integratedBranches = new Set(
      (active.integratedTickets ?? []).map((t) => t.branchName),
    );
    const listed = await bound.workspace.listWorkflowBranches(active.workflowId);
    const candidates = new Set<string>();

    for (const branch of listed) {
      if (integratedBranches.has(branch)) continue;
      // T2 has no successful integrate / PR — discard attempt + integration branches.
      candidates.add(branch);
    }

    // Session-known attempt branches (in case list is incomplete in tests / recovery).
    const sessionBranches = [
      activeWorker?.branchName,
      pendingDisposition?.branchName,
      pendingIntegration?.branchName,
      pendingIntegration?.conflict?.integrationBranch,
      activeConflictWorker?.integrationBranch,
    ].filter((b): b is string => Boolean(b));
    for (const branch of sessionBranches) {
      if (!integratedBranches.has(branch)) {
        candidates.add(branch);
      }
    }

    return [...candidates].sort();
  }

  async function terminateRun(): Promise<RunTerminationResult> {
    const bound = scoped ?? (await requireScoped());
    const active = await loadActiveWorkflow(bound);
    const mode = resolveTerminationMode(active);

    const affectedAttempts = await abortSessionWorkers({
      setCooldown: false,
      transcriptEvent: {
        type: "pipeline:terminate",
        reason: "run-termination",
        mode,
      },
      preservePendingIntegrationMessage:
        mode === "stop-only"
          ? "Conflict resolution worker aborted by Run termination (stop-only). In-progress merge is preserved."
          : "Conflict resolution worker aborted by Run termination; unintegrated artifacts may be discarded.",
    });

    // Also log terminate against pending disposition / integration attempts that
    // had no live worker (so attempt history still records the stop).
    const loggedKeys = new Set(
      affectedAttempts.map(
        (a) => `${a.workflowId}:${a.ticketNumber}:${a.attempt}`,
      ),
    );
    const extraAttempts: Array<{
      workflowId: number;
      ticketNumber: number;
      attempt: number;
    }> = [];
    if (pendingDisposition) {
      extraAttempts.push({
        workflowId: pendingDisposition.workflowId,
        ticketNumber: pendingDisposition.ticketNumber,
        attempt: pendingDisposition.attempt,
      });
    }
    if (pendingIntegration) {
      extraAttempts.push({
        workflowId: pendingIntegration.workflowId,
        ticketNumber: pendingIntegration.ticketNumber,
        attempt: pendingIntegration.attempt,
      });
    }
    for (const key of extraAttempts) {
      const id = `${key.workflowId}:${key.ticketNumber}:${key.attempt}`;
      if (loggedKeys.has(id)) continue;
      loggedKeys.add(id);
      await bound.transcripts.append(key, {
        type: "pipeline:terminate",
        reason: "run-termination",
        mode,
      });
    }

    let discardedBranches: readonly string[] = [];
    let discardedWorktrees: readonly string[] = [];

    if (mode === "discard-unintegrated" && active) {
      const toRemove = await collectUnintegratedBranches(bound, active);
      if (toRemove.length > 0) {
        // Record terminate on discarded attempts even when no live worker remained.
        for (const branch of toRemove) {
          const match =
            /^matt-auto\/(\d+)\/ticket-(\d+)\/r(\d+)$/.exec(branch);
          if (!match) continue;
          const key = {
            workflowId: Number(match[1]),
            ticketNumber: Number(match[2]),
            attempt: Number(match[3]),
          };
          const id = `${key.workflowId}:${key.ticketNumber}:${key.attempt}`;
          if (loggedKeys.has(id)) continue;
          loggedKeys.add(id);
          await bound.transcripts.append(key, {
            type: "pipeline:terminate",
            reason: "run-termination",
            mode,
            discarded: true,
          });
        }
        try {
          const removed = await bound.workspace.removeLocalBranches(toRemove);
          discardedBranches = removed.removedLocalBranches;
          discardedWorktrees = removed.removedWorktrees;
        } catch {
          // Best-effort local discard; run still ends.
          discardedBranches = [];
          discardedWorktrees = [];
        }
      }
      // Session-local unfinished work is discarded with T2 artifacts.
      pendingDisposition = undefined;
      pendingIntegration = undefined;
      pendingCiRecovery = undefined;
      integrationInProgress = false;
    } else {
      // T1 stop-only: clear live run pointers but never rewrite integrated history.
      // Keep pendingIntegration conflict state recoverable for a later retry.
      pendingDisposition = undefined;
      pendingCiRecovery = undefined;
    }

    pipelinePaused = false;
    runTerminated = true;
    lastStopReason = "run-termination";
    lastTerminationMode = mode;

    return {
      mode,
      abortedWorkerCount: affectedAttempts.length,
      affectedAttempts,
      discardedBranches,
      discardedWorktrees,
      runTerminated: true,
    };
  }

  /**
   * If panel still says running but the OS child is gone, synthesize process-exit
   * so the pipeline does not wait forever on a zombie in-memory worker.
   */
  async function reconcileDeadWorkers(bound: RootScopedPorts): Promise<void> {
    if (activeWorker && activeWorker.status === "running") {
      const runtime = bound.workers.getRuntime(activeWorker.workerId);
      if (!runtime || !runtime.alive) {
        const transcriptKey = {
          workflowId: activeWorker.workflowId,
          ticketNumber: activeWorker.ticketNumber,
          attempt: activeWorker.attempt,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "process-gone",
          workerId: activeWorker.workerId,
          pid: activeWorker.pid ?? runtime?.pid,
          reason:
            "Panel still marked running but the OS process is gone; synthesizing process-exit.",
        });
        await handleWorkerEvent(bound, {
          type: "process-exit",
          workerId: activeWorker.workerId,
          code: null,
        });
      }
    }

    if (activeConflictWorker && activeConflictWorker.status === "running") {
      const runtime = bound.workers.getRuntime(activeConflictWorker.workerId);
      if (!runtime || !runtime.alive) {
        const transcriptKey = {
          workflowId: activeConflictWorker.workflowId,
          ticketNumber: activeConflictWorker.ticketNumber,
          attempt: activeConflictWorker.attempt,
        };
        await bound.transcripts.append(transcriptKey, {
          type: "process-gone",
          workerId: activeConflictWorker.workerId,
          pid: activeConflictWorker.pid ?? runtime?.pid,
          reason:
            "Conflict worker still marked running but the OS process is gone; synthesizing process-exit.",
        });
        await handleWorkerEvent(bound, {
          type: "process-exit",
          workerId: activeConflictWorker.workerId,
          code: null,
        });
      }
    }
  }

  function panelWorkerInspection(
    worker: {
      workerId: string;
      workflowId: number;
      ticketNumber: number;
      attempt: number;
      branchName: string;
      worktreePath: string;
      status: ImplementationWorkerStatus;
      progress?: string;
      pid?: number;
    },
    bound: RootScopedPorts,
  ): WorkflowPanelState["workers"][number] {
    const rootPath = selectedPath ?? ports.startPath;
    const transcriptPath = workerTranscriptPath(rootPath, {
      workflowId: worker.workflowId,
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
    });
    const runtime = bound.workers.getRuntime(worker.workerId);
    const pid =
      typeof worker.pid === "number"
        ? worker.pid
        : typeof runtime?.pid === "number"
          ? runtime.pid
          : undefined;
    const entry: WorkflowPanelState["workers"][number] = {
      ticketNumber: worker.ticketNumber,
      attempt: worker.attempt,
      status: worker.status,
      branchName: worker.branchName,
      workerId: worker.workerId,
      worktreePath: worker.worktreePath,
      transcriptPath,
    };
    if (typeof pid === "number") {
      entry.pid = pid;
    }
    if (worker.status === "running") {
      entry.processAlive = runtime?.alive ?? false;
    } else if (runtime) {
      entry.processAlive = runtime.alive;
    }
    if (worker.progress) {
      entry.progress = worker.progress;
    }
    return entry;
  }

  async function getPanelState(): Promise<WorkflowPanelState | undefined> {
    const bound = await requireScoped();
    // Detect zombie running state before snapshotting the panel.
    await reconcileDeadWorkers(bound);
    const active = await loadActiveWorkflow(bound);
    if (!active) return undefined;

    const progress = await loadTicketProgress(bound, active);
    const worker = activeWorker ?? pendingDisposition;
    const workers = worker
      ? [
          panelWorkerInspection(
            {
              workerId: worker.workerId,
              workflowId: worker.workflowId,
              ticketNumber: worker.ticketNumber,
              attempt: worker.attempt,
              branchName: worker.branchName,
              worktreePath: worker.worktreePath,
              status: worker.status,
              ...(worker.progress ? { progress: worker.progress } : {}),
              ...(typeof worker.pid === "number" ? { pid: worker.pid } : {}),
            },
            bound,
          ),
        ]
      : activeConflictWorker
        ? [
            panelWorkerInspection(
              {
                workerId: activeConflictWorker.workerId,
                workflowId: activeConflictWorker.workflowId,
                ticketNumber: activeConflictWorker.ticketNumber,
                attempt: activeConflictWorker.attempt,
                branchName: activeConflictWorker.integrationBranch,
                worktreePath: activeConflictWorker.integrationWorktreePath,
                status: activeConflictWorker.status,
                ...(activeConflictWorker.progress
                  ? { progress: activeConflictWorker.progress }
                  : {}),
                ...(typeof activeConflictWorker.pid === "number"
                  ? { pid: activeConflictWorker.pid }
                  : {}),
              },
              bound,
            ),
          ]
        : [];

    const lines = panelLines(active.workflowId, progress, worker);
    appendWorkflowPrPanelLines(lines, active);
    const state: WorkflowPanelState = {
      workflowId: active.workflowId,
      lines,
      workers,
      pipelinePaused,
    };
    if (runTerminated) {
      state.runTerminated = true;
    }
    if (lastStopReason) {
      state.lastStopReason = lastStopReason;
    }
    if (lastTerminationMode) {
      state.terminationMode = lastTerminationMode;
    }
    if (progress) {
      state.ticketProgress = progress;
    }
    if (active.workflowPr) {
      state.workflowPr = {
        number: active.workflowPr.number,
        status: active.stage === "merged" ? "merged" : "open",
        baseBranch: active.workflowPr.baseBranch,
        headBranch: active.workflowPr.headBranch,
        ...(active.workflowPr.url ? { url: active.workflowPr.url } : {}),
      };
    }
    if (activeConflictWorker) {
      state.integration = {
        ticketNumber: activeConflictWorker.ticketNumber,
        attempt: activeConflictWorker.attempt,
        status: "conflict-resolution",
        branchName: activeConflictWorker.integrationBranch,
        ...(pendingIntegration?.lastFailure
          ? { reason: pendingIntegration.lastFailure }
          : {}),
      };
    } else if (pendingIntegration) {
      state.integration = {
        ticketNumber: pendingIntegration.ticketNumber,
        attempt: pendingIntegration.attempt,
        status: "pending-retry",
        branchName: pendingIntegration.conflict
          ? pendingIntegration.conflict.integrationBranch
          : pendingIntegration.branchName,
        ...(pendingIntegration.lastFailure
          ? { reason: pendingIntegration.lastFailure }
          : {}),
      };
    }

    const ciEntries: NonNullable<WorkflowPanelState["ci"]>[number][] = [];
    if (pendingCiRecovery) {
      ciEntries.push({
        ticketNumber: pendingCiRecovery.ticketNumber,
        attempt: pendingCiRecovery.attempt,
        status: "failure",
        integrationBranch: pendingCiRecovery.integrationBranch,
        ...(pendingCiRecovery.summary ? { summary: pendingCiRecovery.summary } : {}),
        ...(pendingCiRecovery.url ? { url: pendingCiRecovery.url } : {}),
      });
    } else if (progress) {
      for (const ticket of progress.awaitingCi) {
        const integrated = active.integratedTickets?.find((t) => t.number === ticket.number);
        ciEntries.push({
          ticketNumber: ticket.number,
          attempt: integrated?.attempt ?? 1,
          status: "awaiting-check",
          integrationBranch:
            active.integrationBranch ?? integrationBranchName(active.workflowId),
        });
      }
    }
    if (ciEntries.length > 0) {
      state.ci = ciEntries;
    }
    return state;
  }

  async function getWorkerTranscript(input: {
    workflowId: number;
    ticketNumber: number;
    attempt: number;
  }): Promise<readonly unknown[]> {
    const bound = await requireScoped();
    return bound.transcripts.read(input);
  }

  async function currentRoot(): Promise<WorkflowRoot> {
    return ensureSelected();
  }

  let rootsCache: { roots: WorkflowRoot[]; at: number; startPath: string } | undefined;
  const ROOTS_TTL_MS = 30_000;

  async function listRoots(): Promise<WorkflowRoot[]> {
    await ensureSelected();
    if (
      rootsCache &&
      rootsCache.startPath === ports.startPath &&
      Date.now() - rootsCache.at < ROOTS_TTL_MS
    ) {
      return rootsCache.roots;
    }
    const roots = await discoverRoots();
    rootsCache = { roots, at: Date.now(), startPath: ports.startPath };
    return roots;
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

    // Session-owned workers abort cleanly on Workflow-root switching.
    if (scoped && selectedPath && path.resolve(selectedPath) !== resolved) {
      await abortWorkers();
      // Follow-up pointer is session-local to the previous Workflow root.
      lastCompletedWorkflow = undefined;
    }

    bindRoot(match.path);
    return match;
  }

  async function getWorkerProfile(): Promise<
    ResolvedWorkerProfile | undefined
  > {
    const bound = await requireScoped();
    return resolveWorkerProfile(bound);
  }

  async function getGlobalWorkerProfile(): Promise<WorkerProfile | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getGlobalWorkerProfile();
  }

  async function getRootWorkerProfile(): Promise<WorkerProfile | undefined> {
    const bound = await requireScoped();
    return bound.preferences.getRootWorkerProfile();
  }

  async function setGlobalWorkerProfile(profile: WorkerProfile): Promise<void> {
    const bound = await requireScoped();
    await assertValidWorkerProfile(profile);
    await bound.preferences.setGlobalWorkerProfile(profile);
  }

  async function setRootWorkerProfile(profile: WorkerProfile): Promise<void> {
    const bound = await requireScoped();
    await assertValidWorkerProfile(profile);
    await bound.preferences.setRootWorkerProfile(profile);
  }

  async function clearRootWorkerProfile(): Promise<void> {
    const bound = await requireScoped();
    await bound.preferences.clearRootWorkerProfile();
  }

  async function listAvailableModels(): Promise<readonly AvailableModel[]> {
    return ports.models.listAvailableModels();
  }

  async function getHomeModel() {
    return ports.models.getHomeModel();
  }

  async function thinkingLevelsFor(
    provider: string,
    modelId: string,
  ): Promise<readonly string[]> {
    const match = await findAvailableModel(provider, modelId);
    if (!match) return ["off"];
    return match.thinkingLevels;
  }

  return {
    preflight,
    nextActions,
    runNextAction,
    confirmStage,
    getActiveWorkflow,
    getTicketProgress,
    currentRoot,
    listRoots,
    selectRoot,
    getWorkerProfile,
    getGlobalWorkerProfile,
    getRootWorkerProfile,
    setGlobalWorkerProfile,
    setRootWorkerProfile,
    clearRootWorkerProfile,
    listAvailableModels,
    getHomeModel,
    thinkingLevelsFor,
    getPanelState,
    confirmDisposition,
    abortWorkers,
    pausePipeline,
    resumePipeline,
    terminateRun,
    isPipelinePaused,
    isRunTerminated,
    beginPipelineRun,
    isAutoAdvanceBlocked,
    getWorkerTranscript,
  };
}
