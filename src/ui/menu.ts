import type { MattAutoLogger } from "../adapters/logger.js";
import {
  CHECK_CI_ACTION_PREFIX,
  CI_RECOVERY_ACTION_PREFIX,
  CLEANUP_WORKFLOW_ACTION,
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DISPOSITION_ACTION_PREFIX,
  IMPLEMENT_TICKET_ACTION_PREFIX,
  INTEGRATE_TICKET_ACTION_PREFIX,
  MERGE_WORKFLOW_PR_ACTION,
  OPEN_WORKFLOW_PR_ACTION,
  REWORK_TICKET_ACTION_PREFIX,
  START_FOLLOW_UP_ACTION,
  TICKET_PROGRESS_ACTION,
} from "../constants.js";

let menuLogger: MattAutoLogger | undefined;

/** Attach a logger for menu/pipeline diagnostics (local file only). */
export function setMenuLogger(logger: MattAutoLogger | undefined): void {
  menuLogger = logger;
}

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  data?: unknown,
): void {
  menuLogger?.[level](message, data);
}
import type {
  AvailableModel,
  ImplementationDispositionDecision,
  NextAction,
  PreflightCheck,
  PreflightResult,
  ResolvedWorkerProfile,
  SpecDraft,
  StageConfirmationDecision,
  StageResult,
  TicketDraft,
  TicketProgressSummary,
  TicketsDraft,
  WorkerProfile,
  WorkflowCoordinator,
  WorkflowPanelState,
  WorkflowRoot,
} from "../types.js";

/**
 * Choose the next pipeline action without asking the user when rules allow.
 * Ready implement tickets are already frontier-only (no open blockers).
 * Picks the first matching priority class; returns undefined only when a human
 * must choose among unrelated actions.
 */
export function selectPipelineAction(
  nextActions: readonly NextAction[],
): NextAction | undefined {
  // ticket-progress is informational only — never auto-run it or the pipeline
  // will "review tickets" and stall / bounce back to the main menu.
  const actionable = nextActions.filter(
    (a) => a.id !== TICKET_PROGRESS_ACTION.id,
  );
  if (actionable.length === 0) return undefined;
  if (actionable.length === 1) return actionable[0];

  // Do not auto-start a brand-new workflow when both Create-spec and
  // Start Follow-up are offered (typical post-cleanup). Require a human choice.
  const startingNewWorkflow =
    actionable.some((a) => a.id === CREATE_SPEC_ACTION.id) &&
    actionable.some((a) => a.id === START_FOLLOW_UP_ACTION.id);
  const inFlight = startingNewWorkflow
    ? actionable.filter(
        (a) =>
          a.id !== CREATE_SPEC_ACTION.id &&
          a.id !== START_FOLLOW_UP_ACTION.id,
      )
    : actionable;
  if (inFlight.length === 0) return undefined;
  if (inFlight.length === 1) return inFlight[0];

  // Prefer continuing an in-flight workflow over opening a new Create-spec.
  return (
    inFlight.find((a) => a.id === CREATE_TICKETS_ACTION.id) ??
    inFlight.find((a) => a.id.startsWith(DISPOSITION_ACTION_PREFIX)) ??
    inFlight.find((a) => a.id.startsWith(INTEGRATE_TICKET_ACTION_PREFIX)) ??
    inFlight.find((a) => a.id.startsWith(CHECK_CI_ACTION_PREFIX)) ??
    inFlight.find((a) => a.id.startsWith(CI_RECOVERY_ACTION_PREFIX)) ??
    inFlight.find((a) => a.id === OPEN_WORKFLOW_PR_ACTION.id) ??
    inFlight.find((a) => a.id === MERGE_WORKFLOW_PR_ACTION.id) ??
    inFlight.find((a) => a.id === CLEANUP_WORKFLOW_ACTION.id) ??
    inFlight.find((a) => a.id.startsWith(IMPLEMENT_TICKET_ACTION_PREFIX)) ??
    inFlight.find((a) => a.id.startsWith(REWORK_TICKET_ACTION_PREFIX)) ??
    // Create-spec alone among remaining options (e.g. with implement) still auto.
    inFlight.find((a) => a.id === CREATE_SPEC_ACTION.id)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait while session-owned workers run. During that window nextActions is empty
 * on purpose; exiting the pipeline would dump the user back to the main menu.
 */
async function waitForPipelineWorkers(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  ui.notify(
    "Pipeline waiting for Implementation / Conflict workers to finish…",
    "info",
  );
  for (let i = 0; i < 1800; i += 1) {
    // 1800 * 2s ≈ 1 hour max wait
    await sleep(2000);
    const panel = await coordinator.getPanelState();
    // Panel may list pendingDisposition as a "worker" with status
    // needs-disposition — that is NOT still running. Only wait on live runs.
    const running =
      panel?.workers.filter((w) => w.status === "running") ?? [];
    if (running.length === 0) {
      // If disposition is pending, settle immediately so Auto-Close can run.
      // If panel is empty, also settle — caller will re-read nextActions
      // (may hit cooldown after abort/recovery instead of re-Implement thrash).
      log("info", "pipeline:workers-settled", {
        panelWorkers: panel?.workers.map((w) => ({
          ticketNumber: w.ticketNumber,
          attempt: w.attempt,
          status: w.status,
          workerId: w.workerId,
          pid: w.pid,
          processAlive: w.processAlive,
          worktreePath: w.worktreePath,
          transcriptPath: w.transcriptPath,
          branchName: w.branchName,
        })),
      });
      return;
    }
    if (i > 0 && i % 15 === 0) {
      ui.notify(
        `Still waiting on ${running.length} running worker(s)… (${formatPanelLines(panel!).join(" | ")})`,
        "info",
      );
      log("debug", "pipeline:wait-workers-tick", {
        running: running.map((w) => ({
          ticketNumber: w.ticketNumber,
          attempt: w.attempt,
          workerId: w.workerId,
          pid: w.pid,
          processAlive: w.processAlive,
          worktreePath: w.worktreePath,
          transcriptPath: w.transcriptPath,
          branchName: w.branchName,
          progress: w.progress,
        })),
      });
    }
  }
  ui.notify(
    "Timed out waiting for workers. Re-run /matt-auto run to continue.",
    "warning",
  );
  log("warn", "pipeline:wait-workers-timeout");
}

/** Minimal UI surface needed by Matt Auto menus. */
export type MattAutoUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  /**
   * Optional free-text input (used to filter the model catalog).
   * When omitted, model selection falls back to a plain select list.
   */
  input?(
    title: string,
    placeholder?: string,
  ): Promise<string | undefined>;
  /**
   * Optional multi-line editor (used for Create-spec draft capture).
   * When omitted, Create-spec falls back to title + body inputs when available.
   */
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

const PREFLIGHT_HEADER = "--- Workflow preflight ---";
const NEXT_ACTIONS_HEADER = "--- Next actions ---";
const ROOT_HEADER = "--- Workflow root ---";
const WORKER_HEADER = "--- Worker profile ---";
const REFRESH_ITEM = "Refresh preflight";
const SWITCH_ROOT_ITEM = "Switch Workflow root…";
const CONFIGURE_WORKER_ITEM = "Configure Worker profile…";
const RUN_PIPELINE_ITEM =
  "▶ Run post-grill pipeline (to-spec → tickets → implement…)";
const NONE_AVAILABLE = "(none available)";

const SET_GLOBAL_WORKER = "Set global default Worker profile";
const SET_ROOT_WORKER = "Set Workflow-root override";
const CLEAR_ROOT_WORKER = "Clear Workflow-root override";
const BACK_ITEM = "← Back";

const PUBLISH_ITEM = "Publish";
const REVISE_ITEM = "Revise";
const CANCEL_ITEM = "Cancel";

const DISPOSITION_CLOSE = "Close (start Integration)";
const DISPOSITION_LEAVE_OPEN = "Leave open";
const DISPOSITION_INVESTIGATE = "Investigate";
const PANEL_HEADER = "--- Workflow panel ---";

const CREATE_SPEC_EDITOR_TITLE =
  "Create-spec draft (to-spec synthesis; Matt Auto publishes only after Stage confirmation)";

const CREATE_SPEC_EDITOR_PREFILL = `
# Spec title on the first line

## Problem Statement

## Solution

## User Stories

## Implementation Decisions

## Testing Decisions

## Out of Scope

## Further Notes
`.trimStart();

const CREATE_TICKETS_EDITOR_TITLE =
  "Create-tickets breakdown (to-tickets synthesis; Matt Auto publishes only after Stage confirmation)";

const CREATE_TICKETS_EDITOR_PREFILL = `
# One ticket per --- separator. First line of each block: localId | Title | blockedBy: a,b (or none)

1 | First ready ticket | blockedBy: none
## What to build

End-to-end behaviour.

## Acceptance criteria

- [ ] Criterion

---
2 | Dependent ticket | blockedBy: 1
## What to build

Depends on the first ticket.

## Acceptance criteria

- [ ] Criterion
`.trimStart();

const TICKET_PROGRESS_HEADER = "--- Ticket progress ---";

function formatCheckLine(check: PreflightCheck): string {
  const mark = check.ok ? "✓" : "✗";
  const summary = check.guidance.split(".")[0] ?? check.guidance;
  return `${mark} ${check.id}: ${summary}`;
}

function formatNextActionLine(action: NextAction): string {
  return `${action.label} — ${action.description}`;
}

function formatRootStatus(root: WorkflowRoot): string {
  return root.status === "available" ? "available" : "unavailable";
}

function formatProfileShort(profile: WorkerProfile): string {
  return `${profile.provider}/${profile.modelId} (thinking ${profile.thinkingLevel})`;
}

function formatResolvedProfileLine(
  resolved: ResolvedWorkerProfile | undefined,
): string {
  if (!resolved) {
    return "Effective: (not configured)";
  }
  return `Effective: ${formatProfileShort(resolved.profile)} [${resolved.source}]`;
}

/** Compact single-line summary of the current Workflow root. */
export function formatCurrentRootLine(root: WorkflowRoot): string {
  return `Current: ${root.path} (${root.kind}, ${formatRootStatus(root)})`;
}

/** Menu line for a discovered Workflow root candidate. */
export function formatRootOption(root: WorkflowRoot, selected: boolean): string {
  const mark = root.status === "available" ? "✓" : "✗";
  const current = selected ? " (current)" : "";
  return `${mark} ${root.path} — ${root.kind}, ${formatRootStatus(root)}${current}`;
}

/** Compact ticket-progress lines for the Workflow panel / main menu. */
export function formatTicketProgressLines(
  progress: TicketProgressSummary,
): string[] {
  const ready =
    progress.ready.length === 0
      ? "Ready frontier: (none)"
      : `Ready frontier: ${progress.ready.map((t) => `#${t.number} ${t.title}`).join("; ")}`;
  const blocked =
    progress.blocked.length === 0
      ? "Blocked: (none)"
      : `Blocked: ${progress.blocked.map((t) => `#${t.number} (by ${t.openBlockers.map((n) => `#${n}`).join(", ")})`).join("; ")}`;
  return [
    `Tickets: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed (total ${progress.total})`,
    ready,
    blocked,
  ];
}

/** Compact passive Workflow panel lines (not an interactive dashboard). */
export function formatPanelLines(panel: WorkflowPanelState): string[] {
  return [...panel.lines];
}

/** Build bare `/matt-auto` menu lines from coordinator state. */
export function buildMainMenuItems(
  preflight: PreflightResult,
  nextActions: NextAction[],
  currentRoot: WorkflowRoot,
  rootCount: number,
  ticketProgress?: TicketProgressSummary,
  panel?: WorkflowPanelState,
): string[] {
  const nextLines =
    nextActions.length > 0
      ? nextActions.map(formatNextActionLine)
      : [NONE_AVAILABLE];

  const items = [
    ROOT_HEADER,
    formatCurrentRootLine(currentRoot),
    WORKER_HEADER,
    formatResolvedProfileLine(preflight.workerProfile),
    PREFLIGHT_HEADER,
    ...preflight.checks.map(formatCheckLine),
  ];

  if (preflight.ok && nextActions.length > 0) {
    items.push(RUN_PIPELINE_ITEM);
  }

  if (panel && panel.workers.length > 0) {
    items.push(PANEL_HEADER, ...formatPanelLines(panel));
  }

  if (ticketProgress) {
    items.push(TICKET_PROGRESS_HEADER, ...formatTicketProgressLines(ticketProgress));
  }

  items.push(
    NEXT_ACTIONS_HEADER,
    ...nextLines,
    "---",
    CONFIGURE_WORKER_ITEM,
    REFRESH_ITEM,
  );

  if (rootCount > 1) {
    items.push(SWITCH_ROOT_ITEM);
  }

  return items;
}

/**
 * Present the full Matt Auto menu (root, Worker profile, preflight + Next actions).
 * Selecting a failed preflight row shows full corrective guidance.
 */
export async function presentMainMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const currentRoot = await coordinator.currentRoot();
    const roots = await coordinator.listRoots();
    const preflight = await coordinator.preflight();
    const nextActions = await coordinator.nextActions();
    const ticketProgress = await coordinator.getTicketProgress();
    const panel = await coordinator.getPanelState();
    const items = buildMainMenuItems(
      preflight,
      nextActions,
      currentRoot,
      roots.length,
      ticketProgress,
      panel,
    );
    const selected = await ui.select("Matt Auto", items);

    if (selected === undefined) return;
    if (selected === REFRESH_ITEM || selected.startsWith("---")) continue;

    if (
      selected.startsWith("Tickets:") ||
      selected.startsWith("Ready frontier:") ||
      selected.startsWith("Blocked:") ||
      selected.startsWith("Workflow #") ||
      selected.startsWith("Worker #")
    ) {
      // Passive panel / progress rows — show detail, no actions.
      if (panel && (selected.startsWith("Workflow #") || selected.startsWith("Worker #"))) {
        ui.notify(formatPanelLines(panel).join("\n"), "info");
      } else if (ticketProgress) {
        ui.notify(formatTicketProgressLines(ticketProgress).join("\n"), "info");
      }
      continue;
    }

    if (selected === SWITCH_ROOT_ITEM) {
      await presentRootSwitcher(coordinator, ui);
      continue;
    }

    if (selected === CONFIGURE_WORKER_ITEM) {
      await presentWorkerProfileMenu(coordinator, ui);
      continue;
    }

    if (selected === RUN_PIPELINE_ITEM) {
      await runPostGrillPipeline(coordinator, ui);
      continue;
    }

    if (selected.startsWith("Current:")) {
      await notifyCurrentRoot(currentRoot, ui);
      continue;
    }

    if (selected.startsWith("Effective:")) {
      await notifyWorkerProfile(coordinator, ui);
      continue;
    }

    if (selected === NONE_AVAILABLE) {
      if (currentRoot.status === "unavailable" && currentRoot.unavailableReason) {
        ui.notify(currentRoot.unavailableReason, "warning");
      } else if (!preflight.ok) {
        ui.notify(summarizePreflightFailures(preflight), "warning");
      } else {
        ui.notify(
          "Workflow preflight passed. No Next actions are available yet.",
          "info",
        );
      }
      continue;
    }

    const check = preflight.checks.find((c) =>
      selected.includes(`${c.id}:`),
    );
    if (check) {
      ui.notify(check.guidance, check.ok ? "info" : "warning");
      continue;
    }

    const action = nextActions.find((a) => selected.startsWith(a.label));
    if (action) {
      await handleNextAction(coordinator, ui, action);
    }
  }
}

export type NextActionOptions = {
  /**
   * When true, Stage confirmation auto-Publishes and Implementation disposition
   * auto-Closes (starts Integration). Used by `/matt-auto run` for automation.
   * Manual menu actions keep interactive confirms.
   */
  autoAdvance?: boolean;
};

/** Run a Next action and drive Stage confirmation / disposition when required. */
export async function handleNextAction(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  action: NextAction,
  options: NextActionOptions = {},
): Promise<StageResult> {
  const started = Date.now();
  log("info", "handleNextAction:start", {
    id: action.id,
    label: action.label,
    autoAdvance: Boolean(options.autoAdvance),
  });
  let result = await coordinator.runNextAction(action.id);
  result = await resolveStageResult(coordinator, ui, result, options);
  log("info", "handleNextAction:end", {
    id: action.id,
    status: result.status,
    stage: "stage" in result ? result.stage : undefined,
    ms: Date.now() - started,
  });
  notifyStageResult(ui, result);
  return result;
}

/**
 * Post-grill automation entry: drive Create-spec → Create-tickets → implement…
 * Auto-publishes planning drafts and auto-closes implementation dispositions.
 * Only pauses when multiple non-planning Next actions need a human choice
 * (e.g. several implement tickets) or when workers are still running.
 */
export async function runPostGrillPipeline(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  ui.notify(
    "Matt Auto post-grill pipeline (auto-advance): /skill:to-spec → publish → /skill:to-tickets → publish → implement… Stage confirmation is auto-Publish; disposition is auto-Close.",
    "info",
  );
  log("info", "pipeline:start", {
    logFile: menuLogger?.filePath(),
  });

  for (let step = 0; step < 50; step += 1) {
    const stepStarted = Date.now();
    const preflight = await coordinator.preflight();
    log("debug", "pipeline:preflight", {
      step,
      ok: preflight.ok,
      ms: Date.now() - stepStarted,
      failed: preflight.checks.filter((c) => !c.ok).map((c) => c.id),
    });
    if (!preflight.ok) {
      ui.notify(summarizePreflightFailures(preflight), "warning");
      log("warn", "pipeline:stop", { reason: "preflight-failed", step });
      return;
    }

    const nextStarted = Date.now();
    const nextActions = await coordinator.nextActions();
    log("info", "pipeline:nextActions", {
      step,
      ms: Date.now() - nextStarted,
      ids: nextActions.map((a) => a.id),
      labels: nextActions.map((a) => a.label),
    });
    if (nextActions.length === 0) {
      const panel = await coordinator.getPanelState();
      if (panel && panel.workers.length > 0) {
        log("info", "pipeline:wait-workers", {
          workers: panel.workers.map((w) => w.ticketNumber),
        });
        await waitForPipelineWorkers(coordinator, ui);
        continue;
      }
      ui.notify(
        "Pipeline idle — no actionable Next steps (ready frontier may be empty or all tickets blocked).",
        "info",
      );
      log("info", "pipeline:stop", { reason: "idle", step });
      return;
    }

    const preferred = selectPipelineAction(nextActions);
    log("info", "pipeline:select", {
      step,
      preferredId: preferred?.id,
      preferredLabel: preferred?.label,
    });

    let action = preferred;
    if (!action) {
      // Only informational rows (ticket-progress) or unrecognized mix.
      const actionable = nextActions.filter(
        (a) => a.id !== TICKET_PROGRESS_ACTION.id,
      );
      if (actionable.length === 0) {
        ui.notify(
          [
            "Pipeline paused: tickets exist but no ready frontier to implement.",
            ...nextActions.map((a) => `• ${a.label} — ${a.description}`),
            "Unblock tickets or re-run /matt-auto run after fixing blockers.",
          ].join("\n"),
          "warning",
        );
        log("warn", "pipeline:stop", {
          reason: "empty-frontier",
          step,
          nextActions: nextActions.map((a) => a.id),
        });
        return;
      }
      const selected = await ui.select(
        "Pipeline: choose Next action",
        actionable.map(formatNextActionLine),
      );
      if (!selected) {
        ui.notify("Pipeline paused.", "info");
        log("info", "pipeline:stop", { reason: "user-paused", step });
        return;
      }
      action = actionable.find((a) => selected.startsWith(a.label));
      if (!action) return;
      log("info", "pipeline:user-choice", { id: action.id });
    } else {
      ui.notify(`Pipeline next: ${action.label}`, "info");
    }

    const result = await handleNextAction(coordinator, ui, action, {
      autoAdvance: true,
    });
    if (
      result.status === "cancelled" ||
      result.status === "failed" ||
      result.status === "compatibility-recovery"
    ) {
      ui.notify("Pipeline stopped.", "warning");
      log("warn", "pipeline:stop", {
        reason: result.status,
        step,
        stage: "stage" in result ? result.stage : undefined,
        detail: "reason" in result ? result.reason : undefined,
      });
      return;
    }

    // Workflow fully delivered — do not auto Create-spec / Follow-up next.
    if (result.status === "completed" && result.stage === "cleanup") {
      ui.notify(
        "Workflow cleanup finished. Pipeline stopped — start Create-spec or Follow-up deliberately if needed.",
        "info",
      );
      log("info", "pipeline:stop", {
        reason: "workflow-complete",
        step,
        stage: "cleanup",
        workflowId: "workflowId" in result ? result.workflowId : undefined,
      });
      return;
    }

    // Implement returns "running" while the worker is live — wait here instead
    // of falling through to an empty nextActions and exiting to the main menu.
    if (result.status === "running") {
      const panel = await coordinator.getPanelState();
      const ticketNumber =
        "ticketNumber" in result ? result.ticketNumber : undefined;
      const worker =
        (ticketNumber !== undefined
          ? panel?.workers.find((w) => w.ticketNumber === ticketNumber)
          : undefined) ?? panel?.workers[0];
      log("info", "pipeline:worker-running", {
        ticketNumber,
        workerId: worker?.workerId,
        attempt: worker?.attempt,
        pid: worker?.pid,
        processAlive: worker?.processAlive,
        worktreePath: worker?.worktreePath,
        transcriptPath: worker?.transcriptPath,
        branchName: worker?.branchName,
      });
      await waitForPipelineWorkers(coordinator, ui);
    }
  }

  ui.notify("Pipeline reached step limit — re-run /matt-auto run to continue.", "warning");
  log("warn", "pipeline:stop", { reason: "step-limit" });
}

async function resolveStageResult(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  initial: StageResult,
  options: NextActionOptions = {},
): Promise<StageResult> {
  let result = initial;

  while (result.status === "needs-confirmation") {
    if (options.autoAdvance) {
      const title =
        result.stage === "create-spec"
          ? result.draft.title
          : `${result.draft.tickets.length} ticket(s)`;
      ui.notify(
        `Auto-publishing ${result.stage}: ${title}`,
        "info",
      );
      log("info", "stage:auto-publish", {
        stage: result.stage,
        title,
      });
      result = await coordinator.confirmStage("publish");
      continue;
    }

    const decision =
      result.stage === "create-spec"
        ? await presentStageConfirmation(ui, result.draft)
        : await presentTicketsStageConfirmation(ui, result.draft);
    if (!decision) {
      result = await coordinator.confirmStage("cancel");
      break;
    }
    result = await coordinator.confirmStage(decision);
  }

  if (result.status === "running" && result.stage === "implement") {
    ui.notify(
      [
        `Implementation worker running for #${result.ticketNumber} (r${result.attempt}).`,
        `Workspace: ${result.worktreePath}`,
        `Branch: ${result.branchName}`,
        "Watch the Workflow panel for progress. Disposition appears when the worker completes.",
      ].join("\n"),
      "info",
    );
    return result;
  }

  if (result.status === "needs-disposition") {
    result = await resolveDisposition(coordinator, ui, result, options);
  }

  return result;
}

async function resolveDisposition(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  pending: Extract<StageResult, { status: "needs-disposition" }>,
  options: NextActionOptions = {},
): Promise<StageResult> {
  if (options.autoAdvance) {
    ui.notify(
      `Auto-Close #${pending.ticketNumber} (r${pending.attempt}) → start Integration.`,
      "info",
    );
    return coordinator.confirmDisposition("close");
  }

  const decision = await presentImplementationDisposition(ui, pending);
  if (!decision) {
    // Leaving the menu keeps the disposition pending for a later Next action refresh.
    ui.notify(
      `Implementation disposition for #${pending.ticketNumber} is still pending (Close / Leave open / Investigate).`,
      "warning",
    );
    return pending;
  }
  return coordinator.confirmDisposition(decision);
}

/** Implementation disposition menu: Close / Leave open / Investigate. */
export async function presentImplementationDisposition(
  ui: MattAutoUi,
  pending: {
    ticketNumber: number;
    attempt: number;
    summary?: string;
    branchName: string;
  },
): Promise<ImplementationDispositionDecision | undefined> {
  const summary = pending.summary ? `\n${pending.summary}` : "";
  ui.notify(
    `Implementation disposition for #${pending.ticketNumber} (r${pending.attempt}) on ${pending.branchName}.${summary}\nClose starts Integration later and does not close the GitHub ticket yet.`,
    "info",
  );

  const selected = await ui.select("Implementation disposition", [
    DISPOSITION_CLOSE,
    DISPOSITION_LEAVE_OPEN,
    DISPOSITION_INVESTIGATE,
  ]);
  if (selected === DISPOSITION_CLOSE) return "close";
  if (selected === DISPOSITION_LEAVE_OPEN) return "leave-open";
  if (selected === DISPOSITION_INVESTIGATE) return "investigate";
  return undefined;
}

/** Stage confirmation menu for Create-spec: Publish / Revise / Cancel. */
export async function presentStageConfirmation(
  ui: MattAutoUi,
  draft: SpecDraft,
): Promise<StageConfirmationDecision | undefined> {
  const preview =
    draft.body.length > 280 ? `${draft.body.slice(0, 277)}...` : draft.body;
  ui.notify(
    `Stage confirmation for Create-spec\nTitle: ${draft.title}\n\n${preview}`,
    "info",
  );

  return presentConfirmationChoices(ui);
}

/** Stage confirmation menu for Create-tickets: Publish / Revise / Cancel. */
export async function presentTicketsStageConfirmation(
  ui: MattAutoUi,
  draft: TicketsDraft,
): Promise<StageConfirmationDecision | undefined> {
  const lines = draft.tickets.map((ticket) => {
    const blockers =
      ticket.blockedBy.length === 0
        ? "none"
        : ticket.blockedBy.join(", ");
    return `• [${ticket.localId}] ${ticket.title} (blocked by: ${blockers})`;
  });
  ui.notify(
    `Stage confirmation for Create-tickets\n${lines.join("\n")}`,
    "info",
  );

  return presentConfirmationChoices(ui);
}

async function presentConfirmationChoices(
  ui: MattAutoUi,
): Promise<StageConfirmationDecision | undefined> {
  const selected = await ui.select("Stage confirmation", [
    PUBLISH_ITEM,
    REVISE_ITEM,
    CANCEL_ITEM,
  ]);
  if (selected === undefined) return undefined;
  if (selected === PUBLISH_ITEM) return "publish";
  if (selected === REVISE_ITEM) return "revise";
  if (selected === CANCEL_ITEM) return "cancel";
  return undefined;
}

function notifyStageResult(ui: MattAutoUi, result: StageResult): void {
  switch (result.status) {
    case "completed":
      if (result.stage === "create-spec") {
        ui.notify(
          `Published Create-spec as Workflow ID #${result.workflowId}. Workflow manifest written. Next: Create tickets.`,
          "info",
        );
        return;
      }
      if (result.stage === "integrate" || result.stage === "ci-gate") {
        if (result.ticketClosed) {
          ui.notify(
            [
              `CI green for #${result.ticketNumber} (r${result.attempt}).`,
              "Ticket closed; dependents may now be ready.",
              result.integrationBranch
                ? `Integration branch: ${result.integrationBranch}.`
                : undefined,
            ].filter(Boolean).join(" "),
            "info",
          );
          return;
        }
        ui.notify(
          [
            result.stage === "ci-gate"
              ? `CI gate update for #${result.ticketNumber} (r${result.attempt}).`
              : `Integration unit completed for #${result.ticketNumber} (r${result.attempt}).`,
            result.integrationBranch
              ? `Integration branch: ${result.integrationBranch}.`
              : undefined,
            result.pushedBranches?.length
              ? `Pushed: ${result.pushedBranches.join(", ")}.`
              : undefined,
            result.ciStatus === "failure"
              ? result.ciSummary ?? "CI failed — inspect / retry / leave open."
              : "Ticket remains open until CI succeeds.",
            result.ciUrl ? `CI: ${result.ciUrl}` : undefined,
          ].filter(Boolean).join(" "),
          result.ciStatus === "failure" ? "warning" : "info",
        );
        return;
      }
      if (result.stage === "implement") {
        const disposition = result.disposition ?? "unknown";
        const integration = result.integrated
          ? " Integrated (ticket remains open until CI succeeds)."
          : "";
        ui.notify(
          `Implementation disposition "${disposition}" for #${result.ticketNumber} (r${result.attempt}).${integration}`,
          "info",
        );
        return;
      }
      if (result.stage === "workflow-pr") {
        if (result.workflowPrNumber !== undefined) {
          const target = result.targetBranch
            ? ` → ${result.targetBranch}`
            : "";
          ui.notify(
            [
              `Workflow PR #${result.workflowPrNumber}${target}.`,
              result.integrationBranch
                ? `Integration branch: ${result.integrationBranch}.`
                : undefined,
              result.workflowPrUrl ? result.workflowPrUrl : undefined,
            ]
              .filter(Boolean)
              .join(" "),
            "info",
          );
          return;
        }
      }
      if (result.stage === "cleanup") {
        ui.notify(
          [
            `Workflow cleanup completed for #${result.workflowId}.`,
            result.cleanedLocal && result.cleanedRemote
              ? "Local workspaces/transcripts and remote matt-auto branches removed together."
              : undefined,
            "GitHub issue/PR/manifest history retained.",
            result.removedBranches?.length
              ? `Branches: ${result.removedBranches.join(", ")}.`
              : undefined,
          ]
            .filter(Boolean)
            .join(" "),
          "info",
        );
        return;
      }
      if (result.stage === "follow-up") {
        ui.notify(
          `Started Follow-up workflow #${result.workflowId} referencing completed Workflow #${result.followUpOf}. Next: Create tickets.`,
          "info",
        );
        return;
      }
      if (result.ticketProgress) {
        ui.notify(
          [
            `Published Create-tickets for Workflow ID #${result.workflowId}.`,
            `Tickets: ${(result.tickets ?? []).map((n) => `#${n}`).join(", ") || "(none)"}.`,
            ...formatTicketProgressLines(result.ticketProgress),
          ].join("\n"),
          "info",
        );
        return;
      }
      ui.notify(
        `Stage ${result.stage} completed for Workflow ID #${result.workflowId}.`,
        "info",
      );
      return;
    case "cancelled":
      ui.notify(
        `${result.stage === "create-tickets" ? "Create-tickets" : result.stage === "implement" ? "Implement" : "Create-spec"} cancelled. No remote publication was made.`,
        "info",
      );
      return;
    case "compatibility-recovery":
      ui.notify(
        `Compatibility recovery: ${result.reason}`,
        "warning",
      );
      return;
    case "failed":
      ui.notify(result.reason, "error");
      return;
    case "running":
      // Already notified in resolveStageResult.
      return;
    case "needs-disposition":
      ui.notify(
        `Implementation #${result.ticketNumber} is waiting for disposition (Close / Leave open / Investigate).`,
        "warning",
      );
      return;
    case "pending-ci":
      ui.notify(
        [
          `CI pending for #${result.ticketNumber} on ${result.integrationBranch}.`,
          "Control returned immediately — no background polling.",
          "Run Check CI from Next actions when ready.",
          result.ciUrl ? `CI: ${result.ciUrl}` : undefined,
        ].filter(Boolean).join(" "),
        "info",
      );
      return;
    case "needs-ci-recovery":
      ui.notify(
        [
          `CI failed for #${result.ticketNumber} on ${result.integrationBranch}.`,
          result.ciSummary ?? "Inspect / retry / leave open from Next actions.",
          result.ciUrl ? `CI: ${result.ciUrl}` : undefined,
        ].filter(Boolean).join(" "),
        "warning",
      );
      return;
    case "needs-confirmation":
      // Should have been resolved by resolveStageResult.
      ui.notify(
        `${result.stage} is waiting for Stage confirmation (Publish / Revise / Cancel).`,
        "warning",
      );
      return;
  }
}

/**
 * Capture a Create-spec draft in Workflow home without publishing.
 * Used by the Matt skills adapter host; skill definitions stay unmodified.
 */
export async function captureCreateSpecDraft(
  ui: MattAutoUi,
): Promise<SpecDraft | undefined> {
  if (ui.editor) {
    const text = await ui.editor(
      CREATE_SPEC_EDITOR_TITLE,
      CREATE_SPEC_EDITOR_PREFILL,
    );
    if (text === undefined) return undefined;
    return parseDraftFromEditor(text);
  }

  if (!ui.input) {
    ui.notify(
      "Create-spec needs an editor or input UI to capture the to-spec draft without publishing.",
      "warning",
    );
    return undefined;
  }

  const title = await ui.input("Spec title", "Title from to-spec synthesis");
  if (title === undefined) return undefined;
  const body = await ui.input("Spec body", "Full PRD/spec body");
  if (body === undefined) return undefined;
  return { title, body };
}

/**
 * Capture a Create-tickets breakdown in Workflow home without publishing.
 * Used by the Matt skills adapter host; skill definitions stay unmodified.
 */
export async function captureCreateTicketsDraft(
  ui: MattAutoUi,
  input: { workflowId: number; title?: string },
): Promise<TicketsDraft | undefined> {
  const header = input.title
    ? `Workflow #${input.workflowId}: ${input.title}`
    : `Workflow #${input.workflowId}`;

  if (ui.editor) {
    const text = await ui.editor(
      `${CREATE_TICKETS_EDITOR_TITLE}\n${header}`,
      CREATE_TICKETS_EDITOR_PREFILL,
    );
    if (text === undefined) return undefined;
    return parseTicketsDraftFromEditor(text);
  }

  if (!ui.input) {
    ui.notify(
      "Create-tickets needs an editor or input UI to capture the to-tickets breakdown without publishing.",
      "warning",
    );
    return undefined;
  }

  // Minimal single-ticket fallback when only input() is available.
  const title = await ui.input(
    `Ticket title for ${header}`,
    "Title from to-tickets synthesis",
  );
  if (title === undefined) return undefined;
  const body = await ui.input("Ticket body", "What to build / acceptance criteria");
  if (body === undefined) return undefined;
  return {
    tickets: [
      {
        localId: "1",
        title,
        body,
        blockedBy: [],
      },
    ],
  };
}

function parseDraftFromEditor(text: string): SpecDraft | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  if (!title || !body.trim()) return undefined;
  return { title, body };
}

/**
 * Parse a multi-ticket editor capture.
 * Blocks are separated by a line containing only `---`.
 * Header line: `localId | Title | blockedBy: a,b` or `blockedBy: none`.
 */
export function parseTicketsDraftFromEditor(
  text: string,
): TicketsDraft | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Drop a leading instruction comment line starting with `# One ticket`.
  const withoutHelp = trimmed.replace(
    /^#\s*One ticket[\s\S]*?\n(?=\d)/,
    "",
  );

  const blocks = withoutHelp
    .split(/^---\s*$/m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const tickets: TicketDraft[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const header = (lines[0] ?? "").trim();
    const body = lines.slice(1).join("\n").trim();
    const match =
      /^([^|]+)\|([^|]+)\|\s*blockedBy:\s*(.+)$/i.exec(header) ??
      /^([^|]+)\|([^|]+)$/.exec(header);
    if (!match) continue;
    const localId = match[1]?.trim() ?? "";
    const title = match[2]?.trim() ?? "";
    const blockedRaw = (match[3] ?? "none").trim();
    const blockedBy =
      !blockedRaw || /^none$/i.test(blockedRaw)
        ? []
        : blockedRaw
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    if (!localId || !title || !body) continue;
    tickets.push({ localId, title, body, blockedBy });
  }

  if (tickets.length === 0) return undefined;
  return { tickets };
}

/** Interactive Root selection among discovered Workflow roots. */
export async function presentRootSwitcher(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  const current = await coordinator.currentRoot();
  const roots = await coordinator.listRoots();
  if (roots.length === 0) {
    ui.notify("No Workflow roots discovered.", "warning");
    return;
  }

  const options = roots.map((root) =>
    formatRootOption(root, root.path === current.path),
  );
  const selected = await ui.select("Switch Workflow root", options);
  if (!selected) return;

  // Prefer the longest path match so `/workspace` does not steal `/workspace/api`.
  const match = roots
    .filter((root) => selected.includes(root.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!match) return;

  if (match.path === current.path) {
    await notifyCurrentRoot(match, ui);
    return;
  }

  const next = await coordinator.selectRoot(match.path);
  if (next.status === "unavailable" && next.unavailableReason) {
    ui.notify(
      `Switched Workflow root to ${next.path}.\n${next.unavailableReason}`,
      "warning",
    );
    return;
  }

  ui.notify(`Switched Workflow root to ${next.path}.`, "info");
}

/**
 * Worker profile configuration menus.
 * Writes only Matt Auto preferences — never the Workflow home model.
 */
export async function presentWorkerProfileMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const [effective, global, root] = await Promise.all([
      coordinator.getWorkerProfile(),
      coordinator.getGlobalWorkerProfile(),
      coordinator.getRootWorkerProfile(),
    ]);

    const options = [
      `Effective: ${effective ? formatProfileShort(effective.profile) + ` [${effective.source}]` : "(not configured)"}`,
      `Global default: ${global ? formatProfileShort(global) : "(not set)"}`,
      `Workflow-root override: ${root ? formatProfileShort(root) : "(not set)"}`,
      SET_GLOBAL_WORKER,
      SET_ROOT_WORKER,
    ];
    if (root) {
      options.push(CLEAR_ROOT_WORKER);
    }
    options.push(BACK_ITEM);

    const selected = await ui.select("Worker profile", options);
    if (selected === undefined || selected === BACK_ITEM) return;

    if (selected.startsWith("Effective:")) {
      await notifyWorkerProfile(coordinator, ui);
      continue;
    }
    if (selected.startsWith("Global default:")) {
      ui.notify(
        global
          ? `Global default Worker profile: ${formatProfileShort(global)}`
          : "No global default Worker profile is set.",
        "info",
      );
      continue;
    }
    if (selected.startsWith("Workflow-root override:")) {
      ui.notify(
        root
          ? `Workflow-root Worker profile override: ${formatProfileShort(root)}`
          : "No Workflow-root Worker profile override is set.",
        "info",
      );
      continue;
    }

    if (selected === SET_GLOBAL_WORKER) {
      const profile = await promptWorkerProfile(coordinator, ui);
      if (!profile) continue;
      try {
        await coordinator.setGlobalWorkerProfile(profile);
        ui.notify(
          `Global default Worker profile set to ${formatProfileShort(profile)}. Workflow home model is unchanged.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === SET_ROOT_WORKER) {
      const profile = await promptWorkerProfile(coordinator, ui);
      if (!profile) continue;
      try {
        await coordinator.setRootWorkerProfile(profile);
        ui.notify(
          `Workflow-root Worker profile override set to ${formatProfileShort(profile)}. Workflow home model is unchanged.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === CLEAR_ROOT_WORKER) {
      await coordinator.clearRootWorkerProfile();
      ui.notify(
        "Cleared Workflow-root Worker profile override. Effective profile falls back to the global default.",
        "info",
      );
    }
  }
}

/**
 * Prompt for model (home model shortcut + catalog) then thinking level.
 * Model choices come from Pi’s authenticated available catalog and the live
 * Workflow home selection. Never mutates the home model.
 */
export async function promptWorkerProfile(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<WorkerProfile | undefined> {
  const [models, home] = await Promise.all([
    coordinator.listAvailableModels(),
    coordinator.getHomeModel(),
  ]);

  if (models.length === 0 && !home) {
    ui.notify(
      "No authenticated models are available in Pi’s catalog, and Workflow home has no model selected. Authenticate a provider (for example via /login) or pick a home model with /model, then retry.",
      "warning",
    );
    return undefined;
  }

  const model = await selectAvailableModel(models, ui, home ?? undefined);
  if (!model) return undefined;

  const levels = [...model.thinkingLevels];
  if (levels.length === 0) {
    ui.notify(
      `Model ${model.provider}/${model.modelId} reports no supported thinking levels.`,
      "warning",
    );
    return undefined;
  }

  // Prefer home thinking level when the user picked the home model shortcut.
  const preferred =
    home &&
    home.provider === model.provider &&
    home.modelId === model.modelId &&
    levels.includes(home.thinkingLevel)
      ? home.thinkingLevel
      : undefined;
  const orderedLevels = preferred
    ? [preferred, ...levels.filter((level) => level !== preferred)]
    : levels;

  const levelChoice = await ui.select(
    preferred
      ? `Thinking level for ${model.provider}/${model.modelId} (home default first)`
      : `Thinking level for ${model.provider}/${model.modelId}`,
    orderedLevels,
  );
  if (!levelChoice) return undefined;
  if (!levels.includes(levelChoice)) {
    ui.notify(
      `Thinking level "${levelChoice}" is not supported by ${model.provider}/${model.modelId}.`,
      "warning",
    );
    return undefined;
  }

  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: levelChoice,
  };
}

const SEARCH_MODELS_ITEM = "🔍 Search models…";
const USE_HOME_MODEL_PREFIX = "★ Use Workflow home model";

function formatHomeModelOption(home: {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  label: string;
}): string {
  return `${USE_HOME_MODEL_PREFIX} — ${home.provider}/${home.modelId} (thinking ${home.thinkingLevel})`;
}

function matchModelByLabel(
  models: readonly AvailableModel[],
  selected: string,
): AvailableModel | undefined {
  // Longest match first so provider/id prefixes do not steal longer ids.
  return models
    .filter((model) =>
      selected.includes(`${model.provider}/${model.modelId}`),
    )
    .sort(
      (a, b) =>
        `${b.provider}/${b.modelId}`.length -
        `${a.provider}/${a.modelId}`.length,
    )[0];
}

function filterModels(
  models: readonly AvailableModel[],
  query: string,
): AvailableModel[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...models];
  return models.filter((model) => {
    const haystack =
      `${model.provider} ${model.modelId} ${model.label}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Model picker: optional Workflow home shortcut, then full catalog.
 * Optional search is an explicit menu item — never a blank filter screen that
 * looks like an empty catalog.
 * Does not change the Workflow home currently selected model.
 */
export async function selectAvailableModel(
  models: readonly AvailableModel[],
  ui: MattAutoUi,
  home?: {
    provider: string;
    modelId: string;
    thinkingLevel: string;
    label: string;
    thinkingLevels: readonly string[];
  },
): Promise<AvailableModel | undefined> {
  if (models.length === 0 && !home) {
    ui.notify(
      "No models are available to list. Authenticate a provider (for example via /login) or select a home model with /model, then retry.",
      "warning",
    );
    return undefined;
  }

  let catalog: AvailableModel[] = [...models];

  while (true) {
    const homeOption = home ? formatHomeModelOption(home) : undefined;
    const options = [
      ...(homeOption ? [homeOption] : []),
      ...(ui.input !== undefined ? [SEARCH_MODELS_ITEM] : []),
      ...catalog.map((model) => model.label),
    ];

    if (options.length === 0) {
      ui.notify("No models are available to list.", "warning");
      return undefined;
    }

    const selected = await ui.select(
      catalog.length === models.length
        ? `Select Worker model (${catalog.length} available${home ? ", home shortcut on top" : ""})`
        : `Select Worker model (${catalog.length} match${catalog.length === 1 ? "" : "es"})`,
      options,
    );
    if (!selected) return undefined;

    if (home && selected.startsWith(USE_HOME_MODEL_PREFIX)) {
      return {
        provider: home.provider,
        modelId: home.modelId,
        label: home.label,
        thinkingLevels: home.thinkingLevels,
      };
    }

    if (selected === SEARCH_MODELS_ITEM) {
      if (!ui.input) return undefined;
      const query = await ui.input(
        "Search models (provider, id, or name; empty = show all)",
        "e.g. sonnet, openai, gpt…",
      );
      if (query === undefined) continue;
      const filtered = filterModels(models, query);
      if (filtered.length === 0) {
        ui.notify(
          `No models matched "${query.trim()}". Showing full catalog again.`,
          "warning",
        );
        catalog = [...models];
        continue;
      }
      catalog = filtered;
      continue;
    }

    return matchModelByLabel(catalog, selected);
  }
}

/** Present only currently available Next actions (`/matt-auto next`). */
export async function presentNextActions(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  const currentRoot = await coordinator.currentRoot();
  if (currentRoot.status === "unavailable" && currentRoot.unavailableReason) {
    ui.notify(currentRoot.unavailableReason, "warning");
    return;
  }

  const preflight = await coordinator.preflight();
  const nextActions = await coordinator.nextActions();

  if (!preflight.ok) {
    ui.notify(summarizePreflightFailures(preflight), "warning");
    return;
  }

  if (nextActions.length === 0) {
    ui.notify(
      "No Next actions available. Workflow preflight passed; no stages are ready yet.",
      "info",
    );
    return;
  }

  const selected = await ui.select(
    "Matt Auto Next actions",
    nextActions.map(formatNextActionLine),
  );
  if (!selected) return;

  const action = nextActions.find((a) => selected.startsWith(a.label));
  if (action) {
    await handleNextAction(coordinator, ui, action);
  }
}

async function notifyCurrentRoot(
  root: WorkflowRoot,
  ui: MattAutoUi,
): Promise<void> {
  if (root.status === "unavailable" && root.unavailableReason) {
    ui.notify(root.unavailableReason, "warning");
    return;
  }
  ui.notify(
    `Workflow root: ${root.path} (${root.kind}, ${formatRootStatus(root)})`,
    "info",
  );
}

async function notifyWorkerProfile(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  const [effective, global, root] = await Promise.all([
    coordinator.getWorkerProfile(),
    coordinator.getGlobalWorkerProfile(),
    coordinator.getRootWorkerProfile(),
  ]);
  const lines = [
    effective
      ? `Effective Worker profile: ${formatProfileShort(effective.profile)} [${effective.source}]`
      : "Effective Worker profile: (not configured)",
    `Global default: ${global ? formatProfileShort(global) : "(not set)"}`,
    `Workflow-root override: ${root ? formatProfileShort(root) : "(not set)"}`,
    "Configuring Worker profile does not change the Workflow home model.",
  ];
  ui.notify(lines.join("\n"), effective ? "info" : "warning");
}

function summarizePreflightFailures(preflight: PreflightResult): string {
  const failed = preflight.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `• ${c.guidance}`);
  return [
    "No Next actions available — Workflow preflight incomplete:",
    ...lines,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
