import path from "node:path";
import {
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DEFAULT_TARGET_BRANCH,
  dispositionActionId,
  IMPLEMENTATION_DISPOSITION_OPTIONS,
  implementTicketActionId,
  implementationBranchName,
  integrateTicketActionId,
  integrationBranchName,
  NO_GIT_REPOSITORY_REASON,
  parseDispositionActionId,
  parseImplementTicketActionId,
  parseIntegrateTicketActionId,
  REQUIRED_MATT_SKILLS,
  SPEC_ISSUE_LABEL,
  STAGE_CONFIRMATION_OPTIONS,
  TICKET_ISSUE_LABEL,
  TICKET_PROGRESS_ACTION,
  UNSUPPORTED_TRACKER_REASON,
  WORKFLOW_MANIFEST_SCHEMA,
} from "./constants.js";
import type {
  RootScopedPorts,
  TrackerTicket,
  WorkerEventSink,
  WorkflowCoordinatorPorts,
} from "./ports.js";
import type {
  ActiveWorkflow,
  AvailableModel,
  ImplementationDispositionDecision,
  ImplementationWorkerStatus,
  NextAction,
  PreflightCheck,
  PreflightResult,
  ReadyTicket,
  ResolvedWorkerProfile,
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

  async function loadActiveWorkflow(
    bound: RootScopedPorts,
  ): Promise<ActiveWorkflow | undefined> {
    const targetBranch = await resolveTargetBranch(bound.preferences);
    return bound.tracker.findActiveWorkflow(targetBranch);
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
    return draft.title.trim().length > 0 && draft.body.trim().length > 0;
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
  ): TicketProgressSummary {
    const open = tickets.filter((t) => t.state === "OPEN");
    const closed = tickets.filter((t) => t.state === "CLOSED");

    const ready: ReadyTicket[] = [];
    const blocked: TicketProgressSummary["blocked"][number][] = [];

    // Recommendation order: ascending issue number (blockers published first).
    const sortedOpen = [...open].sort((a, b) => a.number - b.number);

    for (const ticket of sortedOpen) {
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
    };
  }

  async function loadTicketProgress(
    bound: RootScopedPorts,
    active: ActiveWorkflow,
  ): Promise<TicketProgressSummary | undefined> {
    if (active.stage !== "tickets-published") {
      return undefined;
    }
    const numbers = active.tickets ?? [];
    if (numbers.length === 0) {
      return {
        workflowId: active.workflowId,
        total: 0,
        open: 0,
        closed: 0,
        ready: [],
        blocked: [],
      };
    }
    const tickets = await bound.tracker.listTickets(numbers);
    return computeTicketProgress(active.workflowId, tickets);
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
    return lines;
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

  async function preflight(): Promise<PreflightResult> {
    const bound = await requireScoped();

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
      return [
        {
          id: CREATE_SPEC_ACTION.id,
          label: CREATE_SPEC_ACTION.label,
          description: CREATE_SPEC_ACTION.description,
        },
      ];
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

    if (active.stage === "tickets-published") {
      // While a worker runs, the passive panel owns progress.
      if (activeWorker || activeConflictWorker) {
        return [];
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

      const progress = await loadTicketProgress(bound, active);
      if (!progress) {
        return [];
      }

      const actions: NextAction[] = progress.ready.map(formatImplementAction);
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
    if (!active || active.stage !== "tickets-published") {
      return {
        status: "failed",
        stage: "implement",
        reason:
          "Implementation workers require an Active workflow with published tickets.",
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
      await bound.workers.launch(
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

    // Fail closed: agent settled without a Stage result.
    worker.status = "compatibility-recovery";
    if (activeWorker?.workerId === worker.workerId) {
      activeWorker = undefined;
    }
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
      await bound.workers.launch(
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

      const manifest: WorkflowManifest = {
        schema: WORKFLOW_MANIFEST_SCHEMA,
        version: 1,
        workflowId: active.workflowId,
        targetBranch: active.targetBranch,
        stage: active.stage,
        workerProfile: active.workerProfile,
        integrationBranch: integrationWorkspace.branchName,
        integratedTickets,
      };
      if (active.tickets) {
        manifest.tickets = [...active.tickets];
      }

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

      // Ticket remains open — CI gate and close land in a later ticket.
      return {
        status: "completed",
        stage: "integrate",
        workflowId: unit.workflowId,
        ticketNumber: unit.ticketNumber,
        attempt: unit.attempt,
        disposition: "close",
        integrated: true,
        integrationBranch: integrationWorkspace.branchName,
        integrationWorktreePath: integrationWorkspace.worktreePath,
        localVerification: {
          ok: true,
          commands: verification.commands,
        },
        pushedBranches,
        branchName: unit.branchName,
        worktreePath: unit.worktreePath,
      };
    } finally {
      if (heldGuard) {
        integrationInProgress = false;
      }
    }
  }

  async function abortWorkers(): Promise<void> {
    const bound = scoped ?? (await requireScoped());
    const worker = activeWorker;
    const conflictWorker = activeConflictWorker;

    try {
      await bound.workers.abortAll();
    } catch {
      // Best-effort abort; session teardown still clears local worker state.
    }

    if (worker) {
      worker.status = "aborted";
      await bound.transcripts.append(
        {
          workflowId: worker.workflowId,
          ticketNumber: worker.ticketNumber,
          attempt: worker.attempt,
        },
        { type: "worker-aborted" },
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
        { type: "conflict-resolution-aborted" },
      );
      if (
        pendingIntegration &&
        pendingIntegration.ticketNumber === conflictWorker.ticketNumber
      ) {
        pendingIntegration.lastFailure =
          "Conflict resolution worker aborted with Workflow home. In-progress merge is preserved for retry.";
      }
    }

    activeWorker = undefined;
    activeConflictWorker = undefined;
  }

  async function getPanelState(): Promise<WorkflowPanelState | undefined> {
    const bound = await requireScoped();
    const active = await loadActiveWorkflow(bound);
    if (!active) return undefined;

    const progress = await loadTicketProgress(bound, active);
    const worker = activeWorker ?? pendingDisposition;
    const workers = worker
      ? [
          {
            ticketNumber: worker.ticketNumber,
            attempt: worker.attempt,
            status: worker.status,
            branchName: worker.branchName,
            ...(worker.progress ? { progress: worker.progress } : {}),
          },
        ]
      : activeConflictWorker
        ? [
            {
              ticketNumber: activeConflictWorker.ticketNumber,
              attempt: activeConflictWorker.attempt,
              status: activeConflictWorker.status,
              branchName: activeConflictWorker.integrationBranch,
              ...(activeConflictWorker.progress
                ? { progress: activeConflictWorker.progress }
                : {}),
            },
          ]
        : [];

    const state: WorkflowPanelState = {
      workflowId: active.workflowId,
      lines: panelLines(active.workflowId, progress, worker),
      workers,
    };
    if (progress) {
      state.ticketProgress = progress;
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

    // Session-owned workers abort cleanly on Workflow-root switching.
    if (scoped && selectedPath && path.resolve(selectedPath) !== resolved) {
      await abortWorkers();
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
    thinkingLevelsFor,
    getPanelState,
    confirmDisposition,
    abortWorkers,
    getWorkerTranscript,
  };
}
