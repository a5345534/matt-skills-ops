import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MattAutoLogger } from "../adapters/logger.js";
import {
  isValidLiveWaitPollIntervalMs,
  isValidWorkerConcurrency,
  resolveLiveWaitPollInterval,
  resolveWorkerConcurrency,
  type WorkerConcurrencySource,
} from "../adapters/preferences.js";
import {
  canPresentLiveWaitControls,
  presentLiveWaitControls,
} from "./live-run-brief-controls.js";
import {
  formatCompletedWorkerTelemetry,
  signalMattAutoComplete,
} from "./terminal-notify.js";
import {
  createFallbackWorkflowActionInteraction,
  executeWorkflowAction,
} from "./workflow-dashboard-actions.js";
import {
  canPresentWorkflowDashboard,
  presentWorkflowDashboard,
  type WorkflowDashboardScope,
} from "./workflow-dashboard.js";
import {
  CHECK_CI_ACTION_PREFIX,
  CI_RECOVERY_ACTION_PREFIX,
  CLEANUP_WORKFLOW_ACTION,
  CREATE_SPEC_ACTION,
  CREATE_TICKETS_ACTION,
  DISPOSITION_ACTION_PREFIX,
  IMPLEMENTATION_DISPOSITION_OPTIONS,
  IMPLEMENT_TICKET_ACTION_PREFIX,
  INTEGRATE_TICKET_ACTION_PREFIX,
  MERGE_WORKFLOW_PR_ACTION,
  OPEN_WORKFLOW_PR_ACTION,
  REWORK_TICKET_ACTION_PREFIX,
  RESUME_WORKFLOW_ACTION_PREFIX,
  START_FOLLOW_UP_ACTION,
  START_NEW_INDEPENDENT_WORKFLOW_ACTION,
  STAGE_CONFIRMATION_OPTIONS,
  TICKET_PROGRESS_ACTION,
  DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS,
  MAX_LIVE_WAIT_POLL_INTERVAL_MS,
  MIN_LIVE_WAIT_POLL_INTERVAL_MS,
  WORKER_CONCURRENCY_WARNING_THRESHOLD,
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
  EmergencyStopResult,
  ImplementationDispositionDecision,
  ImplementationRecoveryState,
  NextAction,
  PreflightCheck,
  PreflightResult,
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
  WorkflowCoordinator,
  WorkflowPanelState,
  WorkflowRoot,
} from "../types.js";
import { getTrackerGhMetrics } from "../adapters/tracker-rate-limit.js";
import { startGhosttyActivity } from "./ghostty-activity.js";
import {
  buildRunBriefViewModel,
  formatRuntimeMs,
  predictRunTerminationMode,
} from "./run-brief.js";
import {
  buildCompactWorkflowPanel,
  formatCompactWorkflowPanelLines,
  publishWorkflowPanel,
} from "./workflow-panel.js";

/**
 * Choose the next pipeline action without asking the user when rules allow.
 * Ready implement tickets are already frontier-only (no open blockers).
 * Picks the first matching priority class; returns undefined only when a human
 * must choose among unrelated actions.
 */
function isReworkNextAction(action: NextAction): boolean {
  return action.id.startsWith(REWORK_TICKET_ACTION_PREFIX);
}

/** Routing choices must always be chosen by the operator, never auto-picked. */
function isWorkflowRoutingAction(action: NextAction): boolean {
  return (
    action.id === START_NEW_INDEPENDENT_WORKFLOW_ACTION.id ||
    action.id.startsWith(RESUME_WORKFLOW_ACTION_PREFIX)
  );
}

/** Human-readable Implementation recovery cooldown lines for pipeline stop/UI. */
export function formatImplementationRecoveryLines(
  recovery: readonly ImplementationRecoveryState[],
  nowMs: number = Date.now(),
): string[] {
  return recovery.map((entry) => {
    const remainingMs = Math.max(0, entry.untilMs - nowMs);
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const until = new Date(entry.untilMs).toISOString().slice(11, 16) + "Z";
    const reason = entry.reason ? ` — ${entry.reason}` : "";
    return `#${entry.ticketNumber}: cooling ~${minutes}m (until ${until})${reason}`;
  });
}

/**
 * Auto-advance picker for `/matt-auto run`.
 *
 * Never auto-selects Rework: Auto-Close leaves integrated tickets closed, and
 * auto-Rework would reopen them forever (close → rework → implement → close).
 * Rework stays available on the interactive Next menu only.
 */
export function selectPipelineAction(
  nextActions: readonly NextAction[],
): NextAction | undefined {
  // ticket-progress is informational only — never auto-run it or the pipeline
  // will "review tickets" and stall / bounce back to the main menu.
  // Rework is operator-only — never auto-advance it.
  const actionable = nextActions.filter(
    (a) => a.id !== TICKET_PROGRESS_ACTION.id && !isReworkNextAction(a),
  );
  if (actionable.length === 0) return undefined;
  if (actionable.some(isWorkflowRoutingAction)) return undefined;
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
    // Create-spec alone among remaining options (e.g. with implement) still auto.
    inFlight.find((a) => a.id === CREATE_SPEC_ACTION.id)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for the pipeline worker wait / run-brief refresh loop. */
export type WaitForPipelineWorkersOptions = {
  /** Poll interval between panel refreshes. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** Max poll iterations. Defaults to 7200 (~1 hour at 0.5s). */
  maxTicks?: number;
  /** Injectable sleep (tests). Defaults to real wall-clock sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When true (default), every running tick opens a select menu with
   * Keep waiting / Pause / Terminate so operators do not depend on shortcuts.
   * Shortcuts and the run-control file still work as secondary paths.
   * Set false only for pure auto-poll (tests / headless).
   */
  offerRunningControls?: boolean;
  /**
   * When true, do not open `presentLiveWaitControls` — a parent persistent live
   * surface already owns the brief for the whole run (still polls at pollIntervalMs).
   */
  skipLiveSurface?: boolean;
};

/**
 * Queued operator action while the wait loop auto-polls (no blocking menu).
 * - pause / terminate: confirm then apply
 * - menu: open Pause/Resume/Terminate select menu
 * - terminate-now: emergency stop without confirmation (file control only)
 */
export type PipelineWaitControlRequest =
  | "pause"
  | "terminate"
  | "menu"
  | "terminate-now";

let pendingPipelineWaitControl: PipelineWaitControlRequest | undefined;

/**
 * Request Pause/Terminate/menu during an auto-waiting run (e.g. keyboard shortcut).
 * Consumed on the next wait-loop tick; pause/terminate still require confirmation
 * unless the request is `terminate-now`.
 */
export function queuePipelineWaitControl(
  action: PipelineWaitControlRequest,
): void {
  pendingPipelineWaitControl = action;
}

/** Test helper: clear any queued wait control. */
export function clearPipelineWaitControlQueue(): void {
  pendingPipelineWaitControl = undefined;
}

/** Absolute path of the out-of-band run control file under a Workflow root. */
export function runControlFilePath(workflowRoot: string): string {
  return path.join(workflowRoot, ".pi", "matt-auto", "run-control");
}

/**
 * Write a run-control request for the wait / pipeline loop (or another shell).
 * Returns the absolute path written.
 */
export async function writeRunControlFile(
  workflowRoot: string,
  action: PipelineWaitControlRequest,
): Promise<string> {
  const file = runControlFilePath(workflowRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${action}\n`, "utf8");
  return file;
}

/**
 * Read and clear `.pi/matt-auto/run-control` if present.
 * Contents (trimmed, case-insensitive): pause | terminate | stop | menu |
 * terminate-now | stop-now.
 */
export async function readAndClearRunControlFile(
  workflowRoot: string,
): Promise<PipelineWaitControlRequest | undefined> {
  const file = runControlFilePath(workflowRoot);
  try {
    const raw = (await readFile(file, "utf8")).trim().toLowerCase();
    try {
      await unlink(file);
    } catch {
      // best-effort clear
    }
    if (raw === "pause") return "pause";
    if (raw === "terminate" || raw === "stop") return "terminate";
    if (raw === "menu" || raw === "controls") return "menu";
    if (raw === "terminate-now" || raw === "stop-now") return "terminate-now";
    log("warn", "pipeline:run-control-unknown", { raw, file });
    return undefined;
  } catch {
    return undefined;
  }
}

function consumePendingWaitControl(): PipelineWaitControlRequest | undefined {
  const queued = pendingPipelineWaitControl;
  pendingPipelineWaitControl = undefined;
  return queued;
}

/** How the run-brief wait loop ended. */
export type WaitForPipelineWorkersResult =
  | { status: "settled" }
  /** Paused safely; the live brief was dismissed with Esc. */
  | { status: "paused" }
  | { status: "terminated"; result: RunTerminationResult }
  | { status: "emergency-stopped"; result: EmergencyStopResult }
  | { status: "timeout" };

function isWaitStopResult(
  result: WaitForPipelineWorkersResult,
): result is
  | { status: "terminated"; result: RunTerminationResult }
  | { status: "emergency-stopped"; result: EmergencyStopResult } {
  return (
    result.status === "terminated" || result.status === "emergency-stopped"
  );
}

/** Coordinator surface required by the run-brief wait / control loop. */
export type RunBriefCoordinator = Pick<
  WorkflowCoordinator,
  | "getPanelState"
  | "pausePipeline"
  | "resumePipeline"
  | "terminateRun"
  | "emergencyStop"
  | "isPipelinePaused"
  | "isRunTerminated"
  | "reconcileBlockedRunningWorkers"
>;

// --- Run brief controls (Pause / Resume / Terminate) ---
// Only controls on the full-screen brief; each requires explicit confirmation.

/** Primary wait control: refresh brief and poll again (does not stop the run). */
const CONTINUE_WAITING_ITEM = "Keep waiting (refresh brief)";
const PAUSE_PIPELINE_ITEM = "Pause pipeline…";
const RESUME_PIPELINE_ITEM = "Resume pipeline…";
const TERMINATE_RUN_ITEM = "Terminate run…";
const EMERGENCY_STOP_ITEM = "Emergency stop (repository-scoped)…";
const CONFIRM_PAUSE_ITEM = "Confirm Pause";
const CONFIRM_RESUME_ITEM = "Confirm Resume";
const CONFIRM_TERMINATE_ITEM = "Confirm Terminate";
const CONFIRM_EMERGENCY_STOP_ITEM = "Confirm Emergency stop";
const DECLINE_CONFIRM_ITEM = "Cancel";

/** Pause confirmation body (bound workflow only; GitHub untouched; workers abort). */
export function pauseConfirmMessage(workflowId: number): string {
  return [
    `Confirm Pause for Workflow #${workflowId}?`,
    "• Abort this bound workflow's session-owned Implementation and Conflict resolution workers",
    "• Release this workflow's worker slots and any held Target-branch lease",
    "• Stop auto-advance for this Matt Auto run",
    "• Sibling workflows are not interrupted",
    "• GitHub issues, labels, manifests, and integrated history stay untouched",
  ].join("\n");
}

/** Resume confirmation body (orchestration-only; not worker dialogue). */
export function resumeConfirmMessage(workflowId: number): string {
  return [
    `Confirm Resume for Workflow #${workflowId}?`,
    "• Clear Pipeline pause and continue orchestration in this Workflow home",
    "• Prefers the latest unintegrated Implementation attempt (branch/worktree/commits)",
    "• Does not resume the aborted worker conversation",
  ].join("\n");
}

/** Terminate confirmation body — copy differs for T1 stop-only vs T2 discard. */
export function terminateConfirmMessage(
  workflowId: number,
  mode: RunTerminationMode,
): string {
  if (mode === "stop-only") {
    return [
      `Confirm Terminate for Workflow #${workflowId}? (stop-only)`,
      "• End this Matt Auto run and abort this bound workflow's session-owned workers",
      "• Release this workflow's worker slots and any held Target-branch lease",
      "• Sibling workflows are not interrupted",
      "• Integrated tickets, closed history, and remote Integration state are preserved",
      "• Unintegrated work is left as-is (not discarded)",
      "• Does not rewrite integrated history or reopen closed tickets",
    ].join("\n");
  }
  return [
    `Confirm Terminate for Workflow #${workflowId}?`,
    "• End this Matt Auto run and abort this bound workflow's session-owned workers",
    "• Release this workflow's worker slots and any held Target-branch lease",
    "• Sibling workflows are not interrupted",
    "• May discard unintegrated attempt workspaces/branches (rollback unfinished work only)",
    "• No successful Integration unit yet — nothing integrated is rewritten",
  ].join("\n");
}

/** Emergency-stop confirmation body — distinct from Pause/Terminate. */
export function emergencyStopConfirmMessage(workflowId: number): string {
  return [
    `Confirm Emergency stop for Workflow #${workflowId}?`,
    "• This is a repository-scoped emergency stop, not a normal Terminate",
    "• Abort this home's session-owned workers and end the run",
    "• Release this home's worker slots, any held Target-branch lease, and the Workflow coordinator lease",
    "• Sibling homes are not directly controlled (fencing prevents releasing leases this home does not hold)",
    "• GitHub integrated history is not rewritten",
  ].join("\n");
}

/** Confirm Pause; decline returns false with no coordinator mutation. */
export async function confirmPauseControl(
  ui: MattAutoUi,
  workflowId: number,
): Promise<boolean> {
  ui.notify(pauseConfirmMessage(workflowId), "warning");
  const selected = await ui.select("Confirm Pause", [
    CONFIRM_PAUSE_ITEM,
    DECLINE_CONFIRM_ITEM,
  ]);
  return selected === CONFIRM_PAUSE_ITEM;
}

/** Confirm Resume; decline returns false with no coordinator mutation. */
export async function confirmResumeControl(
  ui: MattAutoUi,
  workflowId: number,
): Promise<boolean> {
  ui.notify(resumeConfirmMessage(workflowId), "info");
  const selected = await ui.select("Confirm Resume", [
    CONFIRM_RESUME_ITEM,
    DECLINE_CONFIRM_ITEM,
  ]);
  return selected === CONFIRM_RESUME_ITEM;
}

/** Confirm Terminate; decline returns false with no coordinator mutation. */
export async function confirmTerminateControl(
  ui: MattAutoUi,
  workflowId: number,
  mode: RunTerminationMode,
): Promise<boolean> {
  ui.notify(terminateConfirmMessage(workflowId, mode), "warning");
  const selected = await ui.select("Confirm Terminate", [
    CONFIRM_TERMINATE_ITEM,
    DECLINE_CONFIRM_ITEM,
  ]);
  return selected === CONFIRM_TERMINATE_ITEM;
}

/** Confirm Emergency stop; decline returns false with no coordinator mutation. */
export async function confirmEmergencyStopControl(
  ui: MattAutoUi,
  workflowId: number,
): Promise<boolean> {
  ui.notify(emergencyStopConfirmMessage(workflowId), "error");
  const selected = await ui.select("Confirm Emergency stop", [
    CONFIRM_EMERGENCY_STOP_ITEM,
    DECLINE_CONFIRM_ITEM,
  ]);
  return selected === CONFIRM_EMERGENCY_STOP_ITEM;
}

function runningWorkers(panel: WorkflowPanelState | undefined) {
  return panel?.workers.filter((w) => w.status === "running") ?? [];
}

/**
 * Work that the run loop must drive next (P1), even while other Implementation
 * workers are still running. Wait settles early so disposition / Integration
 * retry auto-advance can run without aborting parallel workers.
 */
function hasP1RunLoopWork(panel: WorkflowPanelState | undefined): boolean {
  if (!panel) return false;
  if (panel.workers.some((w) => w.status === "needs-disposition")) return true;
  // pending-retry is actionable; integration "running" is NOT P1 settle — wait.
  if (panel.integration?.status === "pending-retry") return true;
  return false;
}

/** True when the pipeline should keep waiting (live workers / conflict / pause). */
function hasLivePipelineWork(panel: WorkflowPanelState | undefined): boolean {
  if (!panel) return false;
  if (panel.pipelinePaused || panel.runTerminated) return true;
  if (panel.workers.some((w) => w.status === "running")) return true;
  if (panel.integration?.status === "conflict-resolution") return true;
  // Post-conflict finish / active integrate — do not auto-retry while busy.
  if (panel.integration?.status === "running") return true;
  return false;
}

function panelWorkerSnapshot(panel: WorkflowPanelState | undefined) {
  return (
    panel?.workers.map((w) => ({
      ticketNumber: w.ticketNumber,
      attempt: w.attempt,
      status: w.status,
      workerId: w.workerId,
      pid: w.pid,
      processAlive: w.processAlive,
      worktreePath: w.worktreePath,
      transcriptPath: w.transcriptPath,
      branchName: w.branchName,
      turnCount: w.turnCount,
      lastTurnStartedAtMs: w.lastTurnStartedAtMs,
      progress: w.progress,
    })) ?? []
  );
}

function hasControlApis(
  coordinator: Pick<WorkflowCoordinator, "getPanelState">,
): coordinator is RunBriefCoordinator {
  const c = coordinator as Partial<RunBriefCoordinator>;
  return (
    typeof c.pausePipeline === "function" &&
    typeof c.resumePipeline === "function" &&
    typeof c.terminateRun === "function" &&
    typeof c.emergencyStop === "function"
  );
}

function hasReconcileBlockedApi(
  coordinator: Pick<WorkflowCoordinator, "getPanelState">,
): coordinator is Pick<WorkflowCoordinator, "getPanelState"> &
  Pick<WorkflowCoordinator, "reconcileBlockedRunningWorkers"> {
  const c = coordinator as Partial<WorkflowCoordinator>;
  return typeof c.reconcileBlockedRunningWorkers === "function";
}

async function applyQueuedWaitControl(
  controls: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
  queued: PipelineWaitControlRequest,
): Promise<
  | { action: "continue" }
  | { action: "paused" }
  | { action: "resumed" }
  | { action: "dismissed" }
  | { action: "terminated"; result: RunTerminationResult }
  | { action: "emergency-stopped"; result: EmergencyStopResult }
  | { action: "unchanged" }
> {
  if (queued === "pause") {
    const applied = await applyConfirmedPause(controls, ui, panel);
    return applied ? { action: "paused" } : { action: "unchanged" };
  }
  if (queued === "terminate") {
    const result = await applyConfirmedTerminate(controls, ui, panel);
    if (result) return { action: "terminated", result };
    return { action: "unchanged" };
  }
  if (queued === "terminate-now") {
    log("warn", "run-brief:operator-terminate-now", {
      workflowId: panel.workflowId,
    });
    const result = await controls.terminateRun();
    return { action: "terminated", result };
  }
  if (queued === "menu") {
    return presentRunBriefControlMenu(controls, ui, panel);
  }
  return { action: "unchanged" };
}

/**
 * Present the multi-section run brief as the primary wait-surface content.
 * Uses multi-line notify (MVP primitive); content density matches the brief.
 * Also refreshes the secondary compact Workflow panel from the same DTO when
 * the TUI exposes setWidget/setStatus (graceful no-op otherwise).
 */
function notifyRunBrief(
  ui: MattAutoUi,
  panel: WorkflowPanelState,
  type: "info" | "warning" | "error" = "info",
): ReturnType<typeof buildRunBriefViewModel> {
  const brief = buildRunBriefViewModel(panel);
  ui.notify(brief.lines.join("\n"), type);
  // Full brief is primary during wait — do not also paint the compact multi-line
  // widget (that duplicated the ticket table). Keep a one-line footer status only.
  publishWorkflowPanel(ui, panel, { mode: "status-only" });
  return brief;
}

/**
 * Status-line only (no chat dump). Used while the live custom brief is open so
 * the same sections are not stacked in the session transcript on every tick.
 */
function touchRunBriefStatus(
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): ReturnType<typeof buildRunBriefViewModel> {
  const brief = buildRunBriefViewModel(panel, { omitControls: true });
  publishWorkflowPanel(ui, panel, { mode: "status-only" });
  return brief;
}

async function applyConfirmedPause(
  coordinator: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): Promise<boolean> {
  const workflowId = panel.workflowId;
  const confirmed = await confirmPauseControl(ui, workflowId);
  log("info", "run-brief:operator-pause-decision", {
    workflowId,
    decision: confirmed ? "confirm" : "decline",
  });
  if (!confirmed) {
    ui.notify("Pause cancelled — pipeline and workers unchanged.", "info");
    return false;
  }
  const result = await coordinator.pausePipeline();
  log("info", "run-brief:operator-pause", {
    workflowId,
    abortedWorkerCount: result.abortedWorkerCount,
    affectedAttempts: result.affectedAttempts,
  });
  ui.notify(
    [
      `Pipeline paused for Workflow #${workflowId}.`,
      `Aborted ${result.abortedWorkerCount} session-owned worker(s).`,
      "GitHub workflow state is unchanged. Choose Resume or Terminate.",
    ].join("\n"),
    "warning",
  );
  return true;
}

async function applyConfirmedResume(
  coordinator: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): Promise<boolean> {
  const workflowId = panel.workflowId;
  const confirmed = await confirmResumeControl(ui, workflowId);
  log("info", "run-brief:operator-resume-decision", {
    workflowId,
    decision: confirmed ? "confirm" : "decline",
  });
  if (!confirmed) {
    ui.notify("Resume cancelled — pipeline remains paused.", "info");
    return false;
  }
  await coordinator.resumePipeline();
  log("info", "run-brief:operator-resume", { workflowId });
  ui.notify(
    `Pipeline resumed for Workflow #${workflowId}. Continuing orchestration (attempt reuse preferred).`,
    "info",
  );
  return true;
}

async function applyConfirmedTerminate(
  coordinator: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): Promise<RunTerminationResult | undefined> {
  const workflowId = panel.workflowId;
  const mode = predictRunTerminationMode(panel);
  const confirmed = await confirmTerminateControl(ui, workflowId, mode);
  log("info", "run-brief:operator-terminate-decision", {
    workflowId,
    predictedMode: mode,
    decision: confirmed ? "confirm" : "decline",
  });
  if (!confirmed) {
    ui.notify("Terminate cancelled — pipeline and workers unchanged.", "info");
    return undefined;
  }
  const result = await coordinator.terminateRun();
  log("info", "run-brief:operator-terminate", {
    workflowId,
    mode: result.mode,
    abortedWorkerCount: result.abortedWorkerCount,
    affectedAttempts: result.affectedAttempts,
    discardedBranches: result.discardedBranches,
    discardedWorktrees: result.discardedWorktrees,
    releasedTargetBranchLease: result.releasedTargetBranchLease,
    releasedWorkerSlotCount: result.releasedWorkerSlotCount,
  });
  return result;
}

async function applyConfirmedEmergencyStop(
  coordinator: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): Promise<EmergencyStopResult | undefined> {
  const workflowId = panel.workflowId;
  const confirmed = await confirmEmergencyStopControl(ui, workflowId);
  log("info", "run-brief:operator-emergency-stop-decision", {
    workflowId,
    decision: confirmed ? "confirm" : "decline",
  });
  if (!confirmed) {
    ui.notify(
      "Emergency stop cancelled — pipeline and workers unchanged.",
      "info",
    );
    return undefined;
  }
  const result = await coordinator.emergencyStop();
  log("warn", "run-brief:operator-emergency-stop", {
    workflowId,
    abortedWorkerCount: result.abortedWorkerCount,
    releasedTargetBranchLease: result.releasedTargetBranchLease,
    releasedWorkerSlotCount: result.releasedWorkerSlotCount,
    releasedCoordinatorLease: result.releasedCoordinatorLease,
  });
  ui.notify(
    [
      `Emergency stop complete for Workflow #${workflowId}.`,
      `Aborted ${result.abortedWorkerCount} session-owned worker(s).`,
      `Released worker slots: ${result.releasedWorkerSlotCount}.`,
      result.releasedTargetBranchLease
        ? "Released held Target-branch lease."
        : "No Target-branch lease was held by this home.",
      result.releasedCoordinatorLease
        ? "Released Workflow coordinator lease."
        : "No Workflow coordinator lease was held.",
    ].join("\n"),
    "error",
  );
  return result;
}

function formatTerminateNotify(result: RunTerminationResult): string {
  const attempts =
    result.affectedAttempts.length === 0
      ? "none"
      : result.affectedAttempts
          .map(
            (a) =>
              `#${a.ticketNumber} r${a.attempt} (${a.kind}) [wf #${a.workflowId}]`,
          )
          .join("; ");
  if (result.mode === "stop-only") {
    return [
      "Run terminated (stop-only).",
      `Aborted ${result.abortedWorkerCount} session-owned worker(s).`,
      `Affected attempts: ${attempts}.`,
      "Integrated history, closed tickets, and remote Integration state preserved.",
    ].join("\n");
  }
  const discarded =
    result.discardedBranches.length === 0
      ? "(none)"
      : result.discardedBranches.join(", ");
  return [
    "Run terminated.",
    `Aborted ${result.abortedWorkerCount} session-owned worker(s).`,
    `Affected attempts: ${attempts}.`,
    `Discarded unintegrated branches: ${discarded}.`,
  ].join("\n");
}

/**
 * Operator controls on the full-screen run brief.
 * Resume only when paused; Pause when running; Terminate while waiting or paused.
 * Every control requires confirmation before coordinator mutation.
 */
async function presentRunBriefControlMenu(
  coordinator: RunBriefCoordinator,
  ui: MattAutoUi,
  panel: WorkflowPanelState,
): Promise<
  | { action: "continue" }
  | { action: "paused" }
  | { action: "resumed" }
  | { action: "dismissed" }
  | { action: "terminated"; result: RunTerminationResult }
  | { action: "emergency-stopped"; result: EmergencyStopResult }
  | { action: "unchanged" }
> {
  const paused = panel.pipelinePaused === true;
  const options = paused
    ? [RESUME_PIPELINE_ITEM, TERMINATE_RUN_ITEM, EMERGENCY_STOP_ITEM]
    : [
        CONTINUE_WAITING_ITEM,
        PAUSE_PIPELINE_ITEM,
        TERMINATE_RUN_ITEM,
        EMERGENCY_STOP_ITEM,
      ];

  const selected = await ui.select(
    paused
      ? `Matt Auto controls · Workflow #${panel.workflowId} · paused`
      : `Matt Auto controls · Workflow #${panel.workflowId} · pick an option (not a shortcut)`,
    options,
  );

  if (selected === undefined) {
    return paused ? { action: "dismissed" } : { action: "continue" };
  }
  if (selected === CONTINUE_WAITING_ITEM) {
    return { action: "continue" };
  }

  if (selected === PAUSE_PIPELINE_ITEM) {
    const applied = await applyConfirmedPause(coordinator, ui, panel);
    return applied ? { action: "paused" } : { action: "unchanged" };
  }

  if (selected === RESUME_PIPELINE_ITEM) {
    const applied = await applyConfirmedResume(coordinator, ui, panel);
    return applied ? { action: "resumed" } : { action: "unchanged" };
  }

  if (selected === TERMINATE_RUN_ITEM) {
    const result = await applyConfirmedTerminate(coordinator, ui, panel);
    if (result) return { action: "terminated", result };
    return { action: "unchanged" };
  }

  if (selected === EMERGENCY_STOP_ITEM) {
    const result = await applyConfirmedEmergencyStop(coordinator, ui, panel);
    if (result) return { action: "emergency-stopped", result };
    return { action: "unchanged" };
  }

  return { action: "continue" };
}

/**
 * Wait while session-owned workers run, or while Pipeline pause is active.
 * During that window nextActions is empty on purpose; exiting the pipeline
 * would dump the user back to the main menu.
 *
 * Primary operator surface is the full multi-section run brief (U2), refreshed
 * from `getPanelState()`. The only controls are Pause / Resume / Terminate —
 * each requires explicit confirmation before coordinator APIs run.
 *
 * Settles when:
 * - no workers are `running` and the pipeline is not paused, or
 * - P1 run-loop work appears (needs-disposition / Integration pending-retry)
 *   even while other Implementation workers still run, so Auto-Close and
 *   serial Integration can proceed without aborting parallel workers.
 *
 * Terminate exits the wait with `{ status: "terminated" }` so the pipeline
 * can stop cleanly.
 */
export async function waitForPipelineWorkers(
  coordinator: Pick<WorkflowCoordinator, "getPanelState"> | RunBriefCoordinator,
  ui: MattAutoUi,
  options: WaitForPipelineWorkersOptions = {},
): Promise<WaitForPipelineWorkersResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxTicks = options.maxTicks ?? 7200;
  const sleepFn = options.sleep ?? sleep;
  // Default ON: Pause/Terminate must be selectable options. Shortcuts alone
  // failed in real terminals (Ctrl+Alt often never reaches the editor).
  const offerRunningControls = options.offerRunningControls !== false;
  const skipLiveSurface = options.skipLiveSurface === true;
  const controls = hasControlApis(coordinator) ? coordinator : undefined;

  // Full GitHub refresh once; subsequent ticks use local workers + cached tickets
  // so wait loops do not burn GraphQL quota every poll.
  const initialPanel = await coordinator.getPanelState({ mode: "full" });
  const initialRunning = runningWorkers(initialPanel);
  const initialPaused = initialPanel?.pipelinePaused === true;
  const initialP1 = hasP1RunLoopWork(initialPanel);

  const liveWaitAvailable =
    !skipLiveSurface && canPresentLiveWaitControls(ui);

  // Already settled (no live runners, or P1 work ready) and not paused — do not block.
  if ((initialRunning.length === 0 || initialP1) && !initialPaused) {
    log("info", "pipeline:workers-settled", {
      immediate: true,
      p1: initialP1,
      panelWorkers: panelWorkerSnapshot(initialPanel),
    });
    if (initialPanel) {
      notifyRunBrief(ui, initialPanel);
    }
    return { status: "settled" };
  }

  if (initialPanel) {
    // Live custom already paints the full brief — chat-notify here would stack
    // a second copy that never updates while the live surface refreshes.
    const initialBrief = liveWaitAvailable
      ? touchRunBriefStatus(ui, initialPanel)
      : notifyRunBrief(ui, initialPanel);
    log("info", "pipeline:wait-workers", {
      runningCount: initialRunning.length,
      pipelinePaused: initialPaused,
      panelWorkers: panelWorkerSnapshot(initialPanel),
      briefSections: initialBrief.sections.map((s) => s.id),
      liveWait: liveWaitAvailable,
    });
  }

  if (!initialPaused) {
    const controlPath = runControlFilePath(process.cwd());
    if (liveWaitAvailable) {
      // One short line only — do not dump the brief body into chat.
      ui.notify(
        `Live wait · shell fallback: echo terminate-now > ${controlPath}`,
        "info",
      );
    } else if (offerRunningControls) {
      ui.notify(
        [
          "Waiting for workers — use the control menu (select an option):",
          "  • Keep waiting (refresh brief)",
          "  • Pause pipeline…  /  Terminate run…  (each asks for confirm)",
          `Shell fallback: echo terminate-now > ${controlPath}`,
        ].join("\n"),
        "info",
      );
    } else {
      ui.notify(
        [
          "Auto-waiting (no control menu) — use the run-control file.",
          `Shell: echo terminate-now > ${controlPath}`,
        ].join("\n"),
        "info",
      );
    }
  }

  // Home agent is often idle here — pi-ghostty will not spin. Mirror its
  // braille title + OSC 9;4 progress while we wait on session-owned workers.
  const activity = startGhosttyActivity(ui, {
    cwd: process.cwd(),
    detail: activityDetailFromPanel(initialPanel),
  });
  // Do NOT clear pendingPipelineWaitControl here — shortcuts pressed during
  // implement/disposition must still be visible on the first wait tick.

  try {
    // Catch dependents that were launched while a blocker was briefly closed
    // (e.g. Auto-Close then Rework) before the wait surface took over.
    if (hasReconcileBlockedApi(coordinator)) {
      const reconciled = await coordinator.reconcileBlockedRunningWorkers();
      if (reconciled.abortedWorkerCount > 0) {
        ui.notify(
          `Aborted ${reconciled.abortedWorkerCount} Implementation worker(s) that are blocked by open upstream tickets.`,
          "warning",
        );
        log("info", "pipeline:reconcile-blocked-workers", reconciled);
      }
    }

    for (let i = 0; i < maxTicks; i += 1) {
      const panel = await coordinator.getPanelState({ mode: "local" });
      if (!panel) {
        log("info", "pipeline:workers-settled", {
          ticks: i + 1,
          reason: "no-panel",
        });
        return { status: "settled" };
      }

      activity.tick(activityDetailFromPanel(panel));

      if (panel.runTerminated || controls?.isRunTerminated?.()) {
        notifyRunBrief(ui, panel, "warning");
        log("info", "pipeline:wait-terminated-observed", {
          ticks: i + 1,
          workflowId: panel.workflowId,
        });
        if (panel.lastStopReason === "emergency-stop") {
          return {
            status: "emergency-stopped",
            result: {
              abortedWorkerCount: 0,
              affectedAttempts: [],
              releasedTargetBranchLease: false,
              releasedWorkerSlotCount: 0,
              releasedCoordinatorLease: false,
              runTerminated: true,
              lastStopReason: "emergency-stop",
            },
          };
        }
        return {
          status: "terminated",
          result: {
            mode: panel.terminationMode ?? "stop-only",
            abortedWorkerCount: 0,
            affectedAttempts: [],
            discardedBranches: [],
            discardedWorktrees: [],
            runTerminated: true,
            releasedTargetBranchLease: false,
            releasedWorkerSlotCount: 0,
          },
        };
      }

      const paused =
        panel.pipelinePaused === true ||
        (controls?.isPipelinePaused?.() ?? false);
      const running = runningWorkers(panel);

      if (paused) {
        if (liveWaitAvailable) {
          touchRunBriefStatus(ui, panel);
        } else {
          notifyRunBrief(ui, panel, "warning");
        }
        if (!controls) {
          log("warn", "pipeline:paused-without-controls", {
            workflowId: panel.workflowId,
          });
          return { status: "settled" };
        }
        // File / shortcut can terminate while the paused menu is about to open.
        const queuedWhilePaused =
          consumePendingWaitControl() ??
          (await readAndClearRunControlFile(process.cwd()));
        if (queuedWhilePaused === "terminate-now") {
          const result = await controls.terminateRun();
          const latest =
            (await coordinator.getPanelState({ mode: "local" })) ?? panel;
          notifyRunBrief(ui, latest, "warning");
          ui.notify(formatTerminateNotify(result), "warning");
          return { status: "terminated", result };
        }
        if (queuedWhilePaused === "terminate") {
          const result = await applyConfirmedTerminate(controls, ui, panel);
          if (result) {
            const latest =
              (await coordinator.getPanelState({ mode: "local" })) ?? panel;
            notifyRunBrief(ui, latest, "warning");
            ui.notify(formatTerminateNotify(result), "warning");
            return { status: "terminated", result };
          }
        }
        if (liveWaitAvailable) {
          const live = await presentLiveWaitControls(ui, controls, panel, {
            pollIntervalMs,
            onTick: (p) => {
              activity.tick(activityDetailFromPanel(p));
            },
          });
          if (live.action === "dismissed") {
            ui.notify(
              `Pipeline remains paused for Workflow #${panel.workflowId}. Resume later with /matt-auto resume.`,
              "info",
            );
            log("info", "pipeline:pause-dismissed", {
              workflowId: panel.workflowId,
              via: "esc",
            });
            return { status: "paused" };
          }
          if (live.action === "resume") {
            await applyConfirmedResume(controls, ui, panel);
            continue;
          }
          if (live.action === "terminate") {
            const result = await applyConfirmedTerminate(controls, ui, panel);
            if (result) {
              const latest =
                (await coordinator.getPanelState({ mode: "local" })) ?? panel;
              notifyRunBrief(ui, latest, "warning");
              ui.notify(formatTerminateNotify(result), "warning");
              return { status: "terminated", result };
            }
          }
          continue;
        }
        const control = await presentRunBriefControlMenu(controls, ui, panel);
        if (control.action === "terminated") {
          const latest =
            (await coordinator.getPanelState({ mode: "local" })) ?? panel;
          notifyRunBrief(ui, latest, "warning");
          ui.notify(formatTerminateNotify(control.result), "warning");
          return { status: "terminated", result: control.result };
        }
        if (control.action === "emergency-stopped") {
          const latest =
            (await coordinator.getPanelState({ mode: "local" })) ?? panel;
          notifyRunBrief(ui, latest, "error");
          return { status: "emergency-stopped", result: control.result };
        }
        if (control.action === "dismissed") {
          ui.notify(
            `Pipeline remains paused for Workflow #${panel.workflowId}. Resume later with /matt-auto resume.`,
            "info",
          );
          log("info", "pipeline:pause-dismissed", {
            workflowId: panel.workflowId,
            via: "select-cancel",
          });
          return { status: "paused" };
        }
        if (control.action === "resumed") {
          continue;
        }
        continue;
      }

      // P1: disposition / Integration retry must run even while other workers continue.
      if (hasP1RunLoopWork(panel)) {
        notifyRunBrief(ui, panel);
        log("info", "pipeline:workers-settled", {
          ticks: i + 1,
          reason: "p1-run-loop-work",
          runningCount: running.length,
          panelWorkers: panelWorkerSnapshot(panel),
          integration: panel.integration,
        });
        return { status: "settled" };
      }

      if (running.length === 0) {
        notifyRunBrief(ui, panel);
        log("info", "pipeline:workers-settled", {
          ticks: i + 1,
          panelWorkers: panelWorkerSnapshot(panel),
        });
        return { status: "settled" };
      }

      // Periodic reconcile (every ~5s): dependents launched while a blocker was
      // briefly closed must not keep running after the frontier re-blocks them.
      if (
        hasReconcileBlockedApi(coordinator) &&
        (i === 0 || (i + 1) % 10 === 0)
      ) {
        const reconciled = await coordinator.reconcileBlockedRunningWorkers();
        if (reconciled.abortedWorkerCount > 0) {
          ui.notify(
            `Aborted ${reconciled.abortedWorkerCount} Implementation worker(s) blocked by open upstream tickets.`,
            "warning",
          );
          log("info", "pipeline:reconcile-blocked-workers", {
            ticks: i + 1,
            ...reconciled,
          });
          continue;
        }
      }

      // Live custom owns the full brief frame. Chat-notify only for the select
      // fallback — otherwise every outer tick stacks a stale full brief above live.
      const brief = liveWaitAvailable
        ? touchRunBriefStatus(ui, panel)
        : notifyRunBrief(ui, panel);
      const tickPayload: Record<string, unknown> = {
        tick: i + 1,
        runningCount: running.length,
        running: running.map((w) => ({
          ticketNumber: w.ticketNumber,
          attempt: w.attempt,
          workerId: w.workerId,
          pid: w.pid,
          processAlive: w.processAlive,
          worktreePath: w.worktreePath,
          transcriptPath: w.transcriptPath,
          branchName: w.branchName,
          turnCount: w.turnCount,
          lastTurnStartedAtMs: w.lastTurnStartedAtMs,
          progress: w.progress,
        })),
        briefSections: brief.sections.map((s) => s.id),
        briefLines: brief.lines,
        liveWait: liveWaitAvailable,
      };
      // Periodic tracker metrics (every ~30s at 0.5s poll) for rate-limit diagnosis.
      if (i === 0 || (i + 1) % 60 === 0) {
        tickPayload.trackerGh = getTrackerGhMetrics();
      }
      log("debug", "pipeline:wait-workers-tick", tickPayload);

      // Primary: live custom surface (brief refresh + options simultaneously).
      // Fallback: blocking select menu. Shortcuts / run-control file still work.
      if (controls) {
        const queued =
          consumePendingWaitControl() ??
          (await readAndClearRunControlFile(process.cwd()));

        if (queued) {
          const control = await applyQueuedWaitControl(
            controls,
            ui,
            panel,
            queued,
          );
          if (control.action === "terminated") {
            const latest =
              (await coordinator.getPanelState({ mode: "local" })) ?? panel;
            notifyRunBrief(ui, latest, "warning");
            ui.notify(formatTerminateNotify(control.result), "warning");
            return { status: "terminated", result: control.result };
          }
          if (control.action === "emergency-stopped") {
            const latest =
              (await coordinator.getPanelState({ mode: "local" })) ?? panel;
            notifyRunBrief(ui, latest, "error");
            return { status: "emergency-stopped", result: control.result };
          }
          if (control.action === "paused") {
            continue;
          }
        } else if (liveWaitAvailable) {
          const live = await presentLiveWaitControls(ui, controls, panel, {
            pollIntervalMs,
            onTick: (p) => {
              activity.tick(activityDetailFromPanel(p));
            },
          });
          if (live.action === "settled") {
            // Panel may have P1 work or workers finished — re-check outer loop.
            continue;
          }
          if (live.action === "pause") {
            const applied = await applyConfirmedPause(controls, ui, panel);
            if (applied) continue;
          } else if (live.action === "resume") {
            const applied = await applyConfirmedResume(controls, ui, panel);
            if (applied) continue;
          } else if (live.action === "terminate") {
            const result = await applyConfirmedTerminate(controls, ui, panel);
            if (result) {
              const latest =
                (await coordinator.getPanelState({ mode: "local" })) ?? panel;
              notifyRunBrief(ui, latest, "warning");
              ui.notify(formatTerminateNotify(result), "warning");
              return { status: "terminated", result };
            }
          }
          continue;
        } else if (offerRunningControls) {
          const control = await presentRunBriefControlMenu(controls, ui, panel);
          if (control.action === "terminated") {
            const latest =
              (await coordinator.getPanelState({ mode: "local" })) ?? panel;
            notifyRunBrief(ui, latest, "warning");
            ui.notify(formatTerminateNotify(control.result), "warning");
            return { status: "terminated", result: control.result };
          }
          if (control.action === "emergency-stopped") {
            const latest =
              (await coordinator.getPanelState({ mode: "local" })) ?? panel;
            notifyRunBrief(ui, latest, "error");
            return { status: "emergency-stopped", result: control.result };
          }
          if (control.action === "paused") {
            continue;
          }
        }
      }

      await sleepFn(pollIntervalMs);
    }

    ui.notify(
      "Timed out waiting for workers. Re-run /matt-auto run to continue.",
      "warning",
    );
    log("warn", "pipeline:wait-workers-timeout");
    return { status: "timeout" };
  } finally {
    activity.stop();
  }
}

function activityDetailFromPanel(
  panel: WorkflowPanelState | undefined,
): string {
  if (!panel) return "waiting";
  if (panel.pipelinePaused) return "paused";
  if (panel.runTerminated) return "terminated";
  const running = runningWorkers(panel);
  const w = running[0];
  if (w) return `#${w.ticketNumber} r${w.attempt}`;
  return `wf #${panel.workflowId}`;
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
  /**
   * Optional Pi TUI widget surface for the secondary compact Workflow panel.
   * When omitted, panel publish is a graceful no-op (full-screen brief remains primary).
   */
  setWidget?(
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  /**
   * Optional Pi TUI footer status for the compact Workflow panel one-liner.
   * When omitted, status publish is a graceful no-op.
   */
  setStatus?(key: string, text: string | undefined): void;
  /**
   * Optional window/tab title (Pi `setTitle`). Used with pi-ghostty-compatible
   * braille spinner + OSC progress while Matt Auto waits on workers.
   */
  setTitle?(title: string): void;
  /**
   * Optional Pi `ctx.ui.custom()` — live wait surface (brief refresh + options).
   * When present, preferred over blocking `select` during worker wait.
   */
  custom?: <T>(
    factory: (
      tui: { requestRender: () => void },
      // Theme is Pi's Theme; keep loose so we do not depend on ThemeColor unions here.
      theme: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fg: (color: any, text: string) => string;
        bold: (text: string) => string;
      },
      keybindings: unknown,
      done: (value: T) => void,
    ) => {
      render: (width: number) => string[];
      invalidate?: () => void;
      handleInput?: (data: string) => void;
      dispose?: () => void;
    } | Promise<{
      render: (width: number) => string[];
      invalidate?: () => void;
      handleInput?: (data: string) => void;
      dispose?: () => void;
    }>,
    options?: { overlay?: boolean },
  ) => Promise<T | undefined>;
};

const PREFLIGHT_HEADER = "--- Workflow preflight ---";
const NEXT_ACTIONS_HEADER = "--- Next actions ---";
const ROOT_HEADER = "--- Workflow root ---";
const WORKER_HEADER = "--- Worker profile ---";
const WORKER_CONCURRENCY_HEADER = "--- Worker concurrency ---";
const REFRESH_ITEM = "Refresh preflight";
const SWITCH_ROOT_ITEM = "Switch Workflow root…";
const CONFIGURE_WORKER_ITEM = "Configure Worker profile…";
const CONFIGURE_WORKER_CONCURRENCY_ITEM = "Configure Worker concurrency…";
const CONFIGURE_LIVE_WAIT_POLL_ITEM = "Configure live wait poll interval…";
const SET_GLOBAL_LIVE_WAIT_POLL = "Set global default poll interval";
const SET_ROOT_LIVE_WAIT_POLL = "Set Workflow-root poll interval override";
const CLEAR_ROOT_LIVE_WAIT_POLL =
  "Clear Workflow-root poll interval override";
const RUN_PIPELINE_ITEM =
  "▶ Run post-grill pipeline (to-spec → tickets → implement…)";
const NONE_AVAILABLE = "(none available)";

const SET_GLOBAL_WORKER = "Set global default Worker profile";
const SET_ROOT_WORKER = "Set Workflow-root override";
const SET_ACTIVE_WORKFLOW_WORKER =
  "Override Active workflow Worker profile…";
const CLEAR_ROOT_WORKER = "Clear Workflow-root override";
const SET_GLOBAL_WORKER_CONCURRENCY =
  "Set global default Worker concurrency";
const SET_ROOT_WORKER_CONCURRENCY =
  "Set Workflow-root Worker concurrency override";
const CLEAR_ROOT_WORKER_CONCURRENCY =
  "Clear Workflow-root Worker concurrency override";
const BACK_ITEM = "← Back";

const CONFIRM_CONCURRENCY_WARNING_ITEM = "Confirm Worker concurrency";
const DECLINE_CONCURRENCY_WARNING_ITEM = "Cancel";

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

async function presentDashboardIfAvailable(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  scope?: WorkflowDashboardScope,
): Promise<boolean> {
  if (!canPresentWorkflowDashboard(ui)) return false;

  try {
    // Settings rows leave the custom surface so the existing blocking model
    // selectors can run, then reopen the dashboard with the updated prefs.
    for (;;) {
      const result = await presentWorkflowDashboard(coordinator, ui, {
        ...(scope ? { scope } : {}),
      });
      if (result.status === "configure-worker-profile") {
        await presentWorkerProfileMenu(coordinator, ui);
        continue;
      }
      if (result.status === "configure-worker-concurrency") {
        await presentWorkerConcurrencyMenu(coordinator, ui);
        continue;
      }
      return true;
    }
  } catch (error) {
    // A host can expose a partial/RPC `custom` method that rejects at runtime.
    // Keep its established blocking-select menu usable rather than stranding
    // the operator behind a capability probe.
    log("warn", "dashboard:custom-unavailable-fallback", {
      scope: scope ?? "all",
      reason: errorMessage(error),
    });
    return false;
  }
}

function formatResolvedProfileLine(
  resolved: ResolvedWorkerProfile | undefined,
): string {
  if (!resolved) {
    return "Effective: (not configured)";
  }
  return `Effective: ${formatProfileShort(resolved.profile)} [${resolved.source}]`;
}

/** Compact main-menu line for effective Worker concurrency + source. */
export function formatResolvedWorkerConcurrencyLine(
  concurrency: number,
  source: WorkerConcurrencySource,
): string {
  return `Effective Worker concurrency: ${concurrency} [${source}]`;
}

/** True when saving this Worker concurrency requires a Concurrency warning. */
export function needsConcurrencyWarning(
  concurrency: number,
  threshold: number = WORKER_CONCURRENCY_WARNING_THRESHOLD,
): boolean {
  return concurrency > threshold;
}

/** Concurrency warning body shown before saving N above the threshold. */
export function concurrencyWarningMessage(
  concurrency: number,
  threshold: number = WORKER_CONCURRENCY_WARNING_THRESHOLD,
): string {
  return [
    `Concurrency warning: Worker concurrency ${concurrency} exceeds the warning threshold of ${threshold}.`,
    "There is no Matt Auto hard upper limit. Confirming stores this value; run-time slot filling will not re-prompt.",
    "Decline leaves preferences unchanged.",
  ].join("\n");
}

/**
 * Parse free-text Worker concurrency input.
 * Accepts positive integers only (optional surrounding whitespace).
 */
export function parseWorkerConcurrencyInput(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "Worker concurrency must be a positive integer (>= 1).",
    };
  }
  // Reject scientific notation / floats / trailing junk; require pure digits.
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `Invalid Worker concurrency "${trimmed}". Enter a positive integer (>= 1).`,
    };
  }
  const value = Number(trimmed);
  if (!isValidWorkerConcurrency(value)) {
    return {
      ok: false,
      reason: "Worker concurrency must be a positive integer (>= 1).",
    };
  }
  return { ok: true, value };
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

/**
 * Compact passive Workflow panel lines (not an interactive dashboard).
 * Derived from the same panel DTO as the full-screen run brief — not a second channel.
 */
export function formatPanelLines(panel: WorkflowPanelState): string[] {
  return formatCompactWorkflowPanelLines(panel);
}

/** Optional effective Worker concurrency for the main menu summary. */
export type MainMenuWorkerConcurrency = {
  concurrency: number;
  source: WorkerConcurrencySource;
};

/** Build bare `/matt-auto` menu lines from coordinator state. */
export function buildMainMenuItems(
  preflight: PreflightResult,
  nextActions: NextAction[],
  currentRoot: WorkflowRoot,
  rootCount: number,
  ticketProgress?: TicketProgressSummary,
  panel?: WorkflowPanelState,
  workerConcurrency?: MainMenuWorkerConcurrency,
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
  ];

  if (workerConcurrency) {
    items.push(
      WORKER_CONCURRENCY_HEADER,
      formatResolvedWorkerConcurrencyLine(
        workerConcurrency.concurrency,
        workerConcurrency.source,
      ),
    );
  }

  items.push(PREFLIGHT_HEADER, ...preflight.checks.map(formatCheckLine));

  if (preflight.ok && nextActions.length > 0) {
    items.push(RUN_PIPELINE_ITEM);
  }

  if (panel && buildCompactWorkflowPanel(panel).visible) {
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
    CONFIGURE_WORKER_CONCURRENCY_ITEM,
    REFRESH_ITEM,
  );

  if (rootCount > 1) {
    items.push(SWITCH_ROOT_ITEM);
  }

  return items;
}

const HOME_SETTINGS_ITEM = "Settings…";
const HOME_START_NEW_ITEM = "Start new workflow";
const HOME_UNFINISHED_HEADER = "--- Unfinished (local) ---";
const HOME_EMPTY_ITEM = "No local unfinished workflows";

function homeUnfinishedItem(label: string, workflowId: number): string {
  return `${label} [#${workflowId}]`;
}

function parseHomeUnfinishedItem(selected: string): number | undefined {
  const match = /\[#(\d+)\]\s*$/.exec(selected);
  if (!match) return undefined;
  const workflowId = Number(match[1]);
  return Number.isInteger(workflowId) && workflowId > 0 ? workflowId : undefined;
}

/**
 * Fast Matt Auto home: local prefs/transcripts only — never GitHub.
 * Drill-in opens the workflow surface (GitHub) for one selected unfinished id.
 */
export async function presentMattAutoHome(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  pipelineOptions: RunPostGrillPipelineOptions = {},
): Promise<void> {
  for (;;) {
    // Local root resolution is filesystem/git only; no tracker reads.
    await coordinator.currentRoot();
    const unfinished = await coordinator.listLocalUnfinishedWorkflows();
    const items: string[] = [HOME_SETTINGS_ITEM];
    if (unfinished.length === 0) {
      items.push(HOME_EMPTY_ITEM, HOME_START_NEW_ITEM);
    } else {
      items.push(
        HOME_UNFINISHED_HEADER,
        ...unfinished.map((entry) =>
          homeUnfinishedItem(entry.label, entry.workflowId),
        ),
      );
    }

    const selected = await ui.select("Matt Auto", items);
    if (selected === undefined) return;
    if (selected === HOME_EMPTY_ITEM || selected === HOME_UNFINISHED_HEADER) {
      continue;
    }
    if (selected === HOME_SETTINGS_ITEM) {
      await presentHomeSettingsMenu(coordinator, ui);
      continue;
    }
    if (selected === HOME_START_NEW_ITEM) {
      // Network begins here: Create-spec / pipeline needs tracker + skills host.
      await runPostGrillPipeline(coordinator, ui, pipelineOptions);
      continue;
    }
    const workflowId = parseHomeUnfinishedItem(selected);
    if (workflowId === undefined) continue;
    try {
      await coordinator.selectLocalUnfinishedWorkflow(workflowId);
    } catch (error) {
      ui.notify(errorMessage(error), "error");
      continue;
    }
    // Drill-in: full workflow surface may read GitHub.
    if (await presentDashboardIfAvailable(coordinator, ui)) {
      continue;
    }
    await presentWorkflowBlockingMenu(coordinator, ui, pipelineOptions);
  }
}

async function presentHomeSettingsMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const options = [
      CONFIGURE_WORKER_ITEM,
      CONFIGURE_WORKER_CONCURRENCY_ITEM,
      CONFIGURE_LIVE_WAIT_POLL_ITEM,
      SWITCH_ROOT_ITEM,
      BACK_ITEM,
    ];
    const selected = await ui.select("Matt Auto · Settings", options);
    if (selected === undefined || selected === BACK_ITEM) return;
    if (selected === CONFIGURE_WORKER_ITEM) {
      await presentWorkerProfileMenu(coordinator, ui);
      continue;
    }
    if (selected === CONFIGURE_WORKER_CONCURRENCY_ITEM) {
      await presentWorkerConcurrencyMenu(coordinator, ui);
      continue;
    }
    if (selected === CONFIGURE_LIVE_WAIT_POLL_ITEM) {
      await presentLiveWaitPollIntervalMenu(coordinator, ui);
      continue;
    }
    if (selected === SWITCH_ROOT_ITEM) {
      await presentRootSwitcher(coordinator, ui);
    }
  }
}

/** Format effective live-wait poll interval for menus. */
export function formatResolvedLiveWaitPollIntervalLine(
  intervalMs: number,
  source: "workflow-root" | "global" | "default",
): string {
  return `Effective live wait poll: ${intervalMs}ms [${source}]`;
}

/** Parse free-text poll interval (milliseconds). */
export function parseLiveWaitPollIntervalInput(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: `Live wait poll interval must be an integer ${MIN_LIVE_WAIT_POLL_INTERVAL_MS}–${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms.`,
    };
  }
  // Allow optional trailing "ms".
  const digits = trimmed.endsWith("ms") ? trimmed.slice(0, -2).trim() : trimmed;
  if (!/^\d+$/.test(digits)) {
    return {
      ok: false,
      reason: `Invalid poll interval "${raw}". Enter an integer ${MIN_LIVE_WAIT_POLL_INTERVAL_MS}–${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms.`,
    };
  }
  const value = Number(digits);
  if (!isValidLiveWaitPollIntervalMs(value)) {
    return {
      ok: false,
      reason: `Live wait poll interval must be an integer ${MIN_LIVE_WAIT_POLL_INTERVAL_MS}–${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms.`,
    };
  }
  return { ok: true, value };
}

/**
 * Live wait poll interval configuration (global + Workflow-root).
 * Controls how often the run brief refreshes during /matt-auto run.
 */
export async function presentLiveWaitPollIntervalMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const [global, root] = await Promise.all([
      coordinator.getGlobalLiveWaitPollIntervalMs(),
      coordinator.getRootLiveWaitPollIntervalMs(),
    ]);
    const effective = resolveLiveWaitPollInterval(root, global);
    const options = [
      formatResolvedLiveWaitPollIntervalLine(
        effective.intervalMs,
        effective.source,
      ),
      `Global default: ${global !== undefined ? `${global}ms` : "(not set)"}`,
      `Workflow-root override: ${root !== undefined ? `${root}ms` : "(not set)"}`,
      SET_GLOBAL_LIVE_WAIT_POLL,
      SET_ROOT_LIVE_WAIT_POLL,
    ];
    if (root !== undefined) {
      options.push(CLEAR_ROOT_LIVE_WAIT_POLL);
    }
    options.push(BACK_ITEM);

    const selected = await ui.select("Live wait poll interval", options);
    if (selected === undefined || selected === BACK_ITEM) return;

    if (selected.startsWith("Effective live wait poll:")) {
      ui.notify(
        [
          formatResolvedLiveWaitPollIntervalLine(
            effective.intervalMs,
            effective.source,
          ),
          `Allowed range: ${MIN_LIVE_WAIT_POLL_INTERVAL_MS}–${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms (default ${DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS}ms).`,
          "Lower values refresh the brief more often; higher values reduce UI churn.",
        ].join("\n"),
        "info",
      );
      continue;
    }
    if (selected.startsWith("Global default:")) {
      ui.notify(
        global !== undefined
          ? `Global default live wait poll interval: ${global}ms`
          : `No global default set (effective falls back to ${DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS}ms).`,
        "info",
      );
      continue;
    }
    if (selected.startsWith("Workflow-root override:")) {
      ui.notify(
        root !== undefined
          ? `Workflow-root live wait poll override: ${root}ms`
          : "No Workflow-root poll interval override is set.",
        "info",
      );
      continue;
    }

    if (selected === SET_GLOBAL_LIVE_WAIT_POLL) {
      const value = await promptLiveWaitPollInterval(ui, "global default");
      if (value === undefined) continue;
      try {
        await coordinator.setGlobalLiveWaitPollIntervalMs(value);
        ui.notify(`Global live wait poll interval set to ${value}ms.`, "info");
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === SET_ROOT_LIVE_WAIT_POLL) {
      const value = await promptLiveWaitPollInterval(
        ui,
        "Workflow-root override",
      );
      if (value === undefined) continue;
      try {
        await coordinator.setRootLiveWaitPollIntervalMs(value);
        ui.notify(
          `Workflow-root live wait poll interval set to ${value}ms.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === CLEAR_ROOT_LIVE_WAIT_POLL) {
      await coordinator.clearRootLiveWaitPollIntervalMs();
      ui.notify(
        `Cleared Workflow-root poll interval override. Effective falls back to global (or default ${DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS}ms).`,
        "info",
      );
    }
  }
}

export async function promptLiveWaitPollInterval(
  ui: MattAutoUi,
  layerLabel: string,
): Promise<number | undefined> {
  if (!ui.input) {
    ui.notify(
      "Live wait poll interval configuration needs an input UI to enter milliseconds.",
      "warning",
    );
    return undefined;
  }
  const raw = await ui.input(
    `Live wait poll interval (${layerLabel}) — ${MIN_LIVE_WAIT_POLL_INTERVAL_MS}–${MAX_LIVE_WAIT_POLL_INTERVAL_MS} ms`,
    String(DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS),
  );
  if (raw === undefined) return undefined;
  const parsed = parseLiveWaitPollIntervalInput(raw);
  if (!parsed.ok) {
    ui.notify(parsed.reason, "error");
    return undefined;
  }
  return parsed.value;
}

/**
 * Present the full Matt Auto menu (root, Worker profile, preflight + Next actions).
 * Selecting a failed preflight row shows full corrective guidance.
 */
export async function presentMainMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  pipelineOptions: RunPostGrillPipelineOptions = {},
): Promise<void> {
  // Home is local-first and never opens the GitHub-backed dashboard immediately.
  await presentMattAutoHome(coordinator, ui, pipelineOptions);
}

/** Legacy full blocking menu used after drill-in when custom() is unavailable. */
async function presentWorkflowBlockingMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  pipelineOptions: RunPostGrillPipelineOptions = {},
): Promise<void> {
  for (;;) {
    const currentRoot = await coordinator.currentRoot();
    const roots = await coordinator.listRoots();
    const preflight = await coordinator.preflight();
    const nextActions = await coordinator.nextActions();
    const ticketProgress = await coordinator.getTicketProgress();
    const panel = await coordinator.getPanelState();
    const [globalConcurrency, rootConcurrency] = await Promise.all([
      coordinator.getGlobalWorkerConcurrency(),
      coordinator.getRootWorkerConcurrency(),
    ]);
    const resolvedConcurrency = resolveWorkerConcurrency(
      rootConcurrency,
      globalConcurrency,
    );
    // Secondary always-on Workflow panel from the same DTO (no-op without TUI widgets).
    publishWorkflowPanel(ui, panel);
    const panelLines = panel ? formatPanelLines(panel) : [];
    const items = buildMainMenuItems(
      preflight,
      nextActions,
      currentRoot,
      roots.length,
      ticketProgress,
      panel,
      resolvedConcurrency,
    );
    // Offer a way back to the local-only home without Esc-to-chat.
    items.push("← Back to home");
    const selected = await ui.select("Matt Auto · Workflow", items);
    if (selected === "← Back to home") return;

    if (selected === undefined) return;
    if (selected === REFRESH_ITEM || selected.startsWith("---")) continue;

    if (
      selected.startsWith("Tickets:") ||
      selected.startsWith("Ready frontier:") ||
      selected.startsWith("Blocked:") ||
      (panel && panelLines.includes(selected))
    ) {
      // Passive Workflow panel / progress rows — show detail, no actions.
      if (panel && panelLines.includes(selected)) {
        ui.notify(panelLines.join("\n"), "info");
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

    if (selected === CONFIGURE_WORKER_CONCURRENCY_ITEM) {
      await presentWorkerConcurrencyMenu(coordinator, ui);
      continue;
    }

    if (selected === RUN_PIPELINE_ITEM) {
      await runPostGrillPipeline(coordinator, ui, pipelineOptions);
      continue;
    }

    if (selected.startsWith("Current:")) {
      await notifyCurrentRoot(currentRoot, ui);
      continue;
    }

    if (selected.startsWith("Effective Worker concurrency:")) {
      await notifyWorkerConcurrency(coordinator, ui);
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
  const result = await executeWorkflowAction(coordinator, action, {
    interaction: createFallbackWorkflowActionInteraction(ui),
    autoAdvance: options.autoAdvance === true,
    onAutomaticDecision: (prompt) => {
      if (prompt.kind === "stage-confirmation") {
        const title =
          prompt.stage === "create-spec"
            ? prompt.draft.title
            : `${prompt.draft.tickets.length} ticket(s)`;
        ui.notify(`Auto-publishing ${prompt.stage}: ${title}`, "info");
        log("info", "stage:auto-publish", {
          stage: prompt.stage,
          title,
        });
        return;
      }
      ui.notify(
        `Auto-Close #${prompt.ticketNumber} (r${prompt.attempt}) → start Integration.`,
        "info",
      );
    },
  });
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
  }
  log("info", "handleNextAction:end", {
    id: action.id,
    status: result.status,
    stage: "stage" in result ? result.stage : undefined,
    ms: Date.now() - started,
  });
  notifyStageResult(ui, result);
  return result;
}

export type RunPostGrillPipelineOptions = {
  /** Called when a foreground pipeline loop starts or restarts. */
  onPipelineStarted?: () => void;
  /** Called when Esc dismisses a paused live brief back to chat. */
  onPausedDismissed?: () => void;
};

function handlePausedWaitDismissal(
  options: RunPostGrillPipelineOptions,
  step: number,
): void {
  options.onPausedDismissed?.();
  log("info", "pipeline:stop", { reason: "pause-dismissed", step });
}

/**
 * Post-grill automation entry: drive Create-spec → Create-tickets → implement…
 * Auto-publishes planning drafts and auto-closes implementation dispositions.
 * Only pauses when multiple non-planning Next actions need a human choice
 * (e.g. several implement tickets) or when workers are still running.
 *
 * Operator Pause / Resume / Terminate are owned by the full-screen run brief
 * wait surface (with confirmation). Esc may dismiss a paused surface to chat;
 * the extension retains the same coordinator for `/matt-auto resume`.
 */
export async function runPostGrillPipeline(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
  options: RunPostGrillPipelineOptions = {},
): Promise<void> {
  // Clear prior pause / termination so this run can auto-advance.
  coordinator.beginPipelineRun();
  options.onPipelineStarted?.();
  // Drop any stale stop request from a previous run / shortcut.
  await readAndClearRunControlFile(process.cwd());
  clearPipelineWaitControlQueue();
  const controlPath = runControlFilePath(process.cwd());
  ui.notify(
    [
      "Matt Auto post-grill pipeline (auto-advance): /skill:to-spec → publish → /skill:to-tickets → publish → implement…",
      "Stage confirmation is auto-Publish; disposition is auto-Close.",
      "While workers run: select menu — Keep waiting / Pause / Terminate (not shortcuts).",
      `Shell fallback: echo terminate-now > ${controlPath}`,
    ].join("\n"),
    "info",
  );
  log("info", "pipeline:start", {
    logFile: menuLogger?.filePath(),
    runControlFile: controlPath,
  });

  // Set before each return so finally can fire a terminal/title completion signal
  // (pi-notify only hooks agent_end — slash-command runs never get a bell otherwise).
  let endSignal:
    | {
        body: string;
        details?: readonly string[];
        warning?: boolean;
        title?: string;
      }
    | undefined;

  // Persistent live brief for the whole /matt-auto run: stays open across ticket
  // transitions (disposition / integration) with 0.5s local panel polls until
  // the run ends. Pipeline work continues in parallel; per-stage waits skip a
  // second custom() surface so the brief does not disappear between issues.
  let stopPersistentLive = false;
  let persistentLiveOpen = false;
  const persistentLiveCapable = canPresentLiveWaitControls(ui);
  const liveWaitPollIntervalMs =
    typeof coordinator.getEffectiveLiveWaitPollIntervalMs === "function"
      ? await coordinator.getEffectiveLiveWaitPollIntervalMs()
      : DEFAULT_LIVE_WAIT_POLL_INTERVAL_MS;
  log("info", "pipeline:live-wait-poll-interval", {
    intervalMs: liveWaitPollIntervalMs,
  });
  const persistentLivePromise: Promise<unknown> = persistentLiveCapable
    ? (async () => {
        const activity = startGhosttyActivity(ui, {
          cwd: process.cwd(),
          detail: "pipeline",
        });
        try {
          // Create-spec may run before any Active workflow panel exists.
          let panel: WorkflowPanelState | undefined;
          for (let i = 0; i < 120 && !stopPersistentLive; i += 1) {
            panel = await coordinator.getPanelState({ mode: "local" });
            if (panel) break;
            await sleep(250);
          }
          if (!panel || stopPersistentLive) return;
          persistentLiveOpen = true;
          const live = await presentLiveWaitControls(ui, coordinator, panel, {
            pollIntervalMs: liveWaitPollIntervalMs,
            holdUntilRunEnd: true,
            shouldFinish: () =>
              stopPersistentLive || coordinator.isRunTerminated(),
            onTick: (p) => {
              activity.tick(activityDetailFromPanel(p));
            },
          });
          // Operator used live controls — apply confirmations after custom() closes.
          const latest =
            (await coordinator.getPanelState({ mode: "local" })) ?? panel;
          if (live.action === "pause") {
            await applyConfirmedPause(coordinator, ui, latest);
          } else if (live.action === "terminate") {
            const result = await applyConfirmedTerminate(
              coordinator,
              ui,
              latest,
            );
            if (result) {
              ui.notify(formatTerminateNotify(result), "warning");
            }
          } else if (live.action === "resume") {
            await applyConfirmedResume(coordinator, ui, latest);
          }
        } finally {
          persistentLiveOpen = false;
          activity.stop();
        }
      })().catch((error) => {
        persistentLiveOpen = false;
        log("warn", "pipeline:persistent-live-failed", {
          reason: errorMessage(error),
        });
      })
    : Promise.resolve();
  const skipPersistentLiveSurface = () =>
    persistentLiveCapable && persistentLiveOpen;

  try {
  for (let step = 0; step < 50; step += 1) {
    // Out-of-band stop between stages (shortcuts + run-control file).
    const midRunControl =
      consumePendingWaitControl() ??
      (await readAndClearRunControlFile(process.cwd()));
    if (midRunControl === "terminate-now" || midRunControl === "terminate") {
      if (midRunControl === "terminate") {
        const panel = await coordinator.getPanelState({ mode: "local" });
        if (panel) {
          const confirmed = await confirmTerminateControl(
            ui,
            panel.workflowId,
            predictRunTerminationMode(panel),
          );
          if (!confirmed) {
            ui.notify("Terminate cancelled — pipeline continues.", "info");
          } else {
            const result = await coordinator.terminateRun();
            ui.notify(formatTerminateNotify(result), "warning");
            log("info", "pipeline:stop", {
              reason: "run-terminated",
              step,
              mode: result.mode,
              via: "mid-run-control",
            });
            return;
          }
        } else {
          const result = await coordinator.terminateRun();
          ui.notify(formatTerminateNotify(result), "warning");
          return;
        }
      } else {
        const result = await coordinator.terminateRun();
        ui.notify(formatTerminateNotify(result), "warning");
        log("info", "pipeline:stop", {
          reason: "run-terminated",
          step,
          mode: result.mode,
          via: "terminate-now",
        });
        return;
      }
    } else if (midRunControl === "pause") {
      const panel = await coordinator.getPanelState({ mode: "local" });
      if (panel) {
        await applyConfirmedPause(coordinator, ui, panel);
      } else {
        await coordinator.pausePipeline();
      }
    }

    if (coordinator.isRunTerminated()) {
      ui.notify("Run terminated — pipeline stopped.", "warning");
      log("info", "pipeline:stop", { reason: "run-terminated", step });
      endSignal = {
        body: "Matt Auto run terminated.",
        warning: true,
      };
      return;
    }

    // Pipeline pause keeps the brief visible until Resume or Terminate.
    if (coordinator.isPipelinePaused()) {
      const waitResult = await waitForPipelineWorkers(coordinator, ui, {
        pollIntervalMs: liveWaitPollIntervalMs,
        skipLiveSurface: skipPersistentLiveSurface(),
      });
      if (isWaitStopResult(waitResult)) {
        log("info", "pipeline:stop", {
          reason:
            waitResult.status === "emergency-stopped"
              ? "emergency-stop"
              : "run-terminated",
          step,
          ...(waitResult.status === "terminated"
            ? { mode: waitResult.result.mode }
            : {}),
        });
        endSignal = {
          body:
            waitResult.status === "emergency-stopped"
              ? "Matt Auto emergency stop complete."
              : "Matt Auto run terminated.",
          warning: true,
        };
        return;
      }
      if (waitResult.status === "paused") {
        handlePausedWaitDismissal(options, step);
        return;
      }
      continue;
    }

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
      endSignal = {
        body: "Matt Auto preflight failed — see notice in session.",
        warning: true,
      };
      return;
    }

    const nextStarted = Date.now();
    const nextActions = await coordinator.nextActions();
    const nextDiagnostic =
      typeof coordinator.getNextActionsDiagnostic === "function"
        ? coordinator.getNextActionsDiagnostic()
        : undefined;
    log("info", "pipeline:nextActions", {
      step,
      ms: Date.now() - nextStarted,
      ids: nextActions.map((a) => a.id),
      labels: nextActions.map((a) => a.label),
      ...(nextDiagnostic ? { diagnostic: nextDiagnostic } : {}),
    });
    if (nextActions.length === 0) {
      const diagnostic = nextDiagnostic;
      const panel = await coordinator.getPanelState();
      // Slots full (or no ready launch) while workers / conflict / pause live → wait.
      // waitForPipelineWorkers settles early on P1 (needs-disposition / pending-retry)
      // so disposition auto-advance runs while other Implementation workers continue.
      if (hasLivePipelineWork(panel)) {
        log("info", "pipeline:wait-workers", {
          workers: panel?.workers.map((w) => ({
            ticketNumber: w.ticketNumber,
            status: w.status,
          })),
          pipelinePaused: panel?.pipelinePaused,
          runTerminated: panel?.runTerminated,
          integration: panel?.integration,
          ...(diagnostic ? { nextActionsDiagnostic: diagnostic } : {}),
        });
        const waitResult = await waitForPipelineWorkers(coordinator, ui, {
          pollIntervalMs: liveWaitPollIntervalMs,
          skipLiveSurface: skipPersistentLiveSurface(),
        });
        if (isWaitStopResult(waitResult)) {
          log("info", "pipeline:stop", {
            reason:
              waitResult.status === "emergency-stopped"
                ? "emergency-stop"
                : "run-terminated",
            step,
            ...(waitResult.status === "terminated"
              ? { mode: waitResult.result.mode }
              : {}),
          });
          return;
        }
        if (waitResult.status === "paused") {
          handlePausedWaitDismissal(options, step);
          return;
        }
        continue;
      }
      if (diagnostic?.routeKind === "unavailable" || diagnostic?.reason) {
        const reason =
          diagnostic.reason ??
          "Workflow home routing is unavailable after a green preflight.";
        ui.notify(
          [
            "Pipeline stopped: Workflow home cannot produce Next actions.",
            reason,
            diagnostic.routeKind
              ? `Route: ${diagnostic.routeKind}`
              : undefined,
            diagnostic.workflowId !== undefined
              ? `Workflow #${diagnostic.workflowId}`
              : undefined,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          "warning",
        );
        log("warn", "pipeline:stop", {
          reason:
            diagnostic.routeKind === "unavailable"
              ? "workflow-home-unavailable"
              : "next-actions-empty",
          step,
          nextActionsDiagnostic: diagnostic,
        });
        endSignal = {
          body: reason,
          warning: true,
        };
        return;
      }
      ui.notify(
        "Pipeline idle — no actionable Next steps (ready frontier may be empty or all tickets blocked).",
        "info",
      );
      log("info", "pipeline:stop", {
        reason: "idle",
        step,
        ...(diagnostic ? { nextActionsDiagnostic: diagnostic } : {}),
      });
      return;
    }

    // Do not auto-advance while Pipeline pause / Run termination blocks the run.
    if (coordinator.isAutoAdvanceBlocked()) {
      if (coordinator.isRunTerminated()) {
        ui.notify("Run terminated — pipeline stopped.", "warning");
        log("info", "pipeline:stop", { reason: "run-terminated", step });
        endSignal = {
          body: "Matt Auto run terminated.",
          warning: true,
        };
        return;
      }
      const waitResult = await waitForPipelineWorkers(coordinator, ui, {
        pollIntervalMs: liveWaitPollIntervalMs,
        skipLiveSurface: skipPersistentLiveSurface(),
      });
      if (isWaitStopResult(waitResult)) {
        log("info", "pipeline:stop", {
          reason:
            waitResult.status === "emergency-stopped"
              ? "emergency-stop"
              : "run-terminated",
          step,
          ...(waitResult.status === "terminated"
            ? { mode: waitResult.result.mode }
            : {}),
        });
        endSignal = {
          body:
            waitResult.status === "emergency-stopped"
              ? "Matt Auto emergency stop complete."
              : "Matt Auto run terminated.",
          warning: true,
        };
        return;
      }
      if (waitResult.status === "paused") {
        handlePausedWaitDismissal(options, step);
        return;
      }
      continue;
    }

    const preferred = selectPipelineAction(nextActions);
    log("info", "pipeline:select", {
      step,
      preferredId: preferred?.id,
      preferredLabel: preferred?.label,
    });

    let action = preferred;
    if (!action) {
      // Only informational rows, rework-only, or unrecognized mix.
      const actionable = nextActions.filter(
        (a) => a.id !== TICKET_PROGRESS_ACTION.id,
      );
      const autoActionable = actionable.filter((a) => !isReworkNextAction(a));
      if (autoActionable.length === 0) {
        // Rework is operator-only. If workers are still live, wait; else stop
        // without reopening closed integrated tickets (prevents rework loops).
        if (actionable.some(isReworkNextAction)) {
          const panel = await coordinator.getPanelState();
          if (hasLivePipelineWork(panel)) {
            log("info", "pipeline:wait-workers", {
              reason: "rework-not-auto",
              workers: panel?.workers.map((w) => ({
                ticketNumber: w.ticketNumber,
                status: w.status,
              })),
            });
            const waitResult = await waitForPipelineWorkers(coordinator, ui, {
        pollIntervalMs: liveWaitPollIntervalMs,
        skipLiveSurface: skipPersistentLiveSurface(),
      });
            if (isWaitStopResult(waitResult)) {
              log("info", "pipeline:stop", {
                reason:
                  waitResult.status === "emergency-stopped"
                    ? "emergency-stop"
                    : "run-terminated",
                step,
                ...(waitResult.status === "terminated"
                  ? { mode: waitResult.result.mode }
                  : {}),
              });
              return;
            }
            if (waitResult.status === "paused") {
              handlePausedWaitDismissal(options, step);
              return;
            }
            continue;
          }
          const recovery = coordinator.getImplementationRecoveryStates();
          const recoveryLines =
            formatImplementationRecoveryLines(recovery);
          ui.notify(
            [
              "Pipeline stopped: only Rework actions remain, and Rework is not auto-advanced.",
              ...(recoveryLines.length > 0
                ? [
                    "Ready tickets are in Implementation recovery cooldown (auto Implement withheld):",
                    ...recoveryLines.map((line) => `• ${line}`),
                    "Wait for cooldown, /reload to clear session cooldown, or fix the worker model/provider error and re-run.",
                  ]
                : [
                    "Closed integrated tickets stay closed so Auto-Close cannot loop into Rework.",
                    "Use /matt-auto next to rework a ticket deliberately, or wait for the ready frontier.",
                  ]),
              ...actionable.map((a) => `• ${a.label} — ${a.description}`),
            ].join("\n"),
            recoveryLines.length > 0 ? "warning" : "info",
          );
          log("info", "pipeline:stop", {
            reason:
              recoveryLines.length > 0
                ? "implementation-recovery-cooldown"
                : "rework-not-auto",
            step,
            nextActions: nextActions.map((a) => a.id),
            implementationRecovery: recovery.map((entry) => ({
              ticketNumber: entry.ticketNumber,
              remainingMs: entry.remainingMs,
              untilMs: entry.untilMs,
              ...(entry.reason ? { reason: entry.reason } : {}),
            })),
          });
          return;
        }
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
        autoActionable.map(formatNextActionLine),
      );
      if (!selected) {
        ui.notify("Pipeline paused.", "info");
        log("info", "pipeline:stop", { reason: "user-paused", step });
        return;
      }
      action = autoActionable.find((a) => selected.startsWith(a.label));
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
      const detail =
        "reason" in result && typeof result.reason === "string"
          ? result.reason
          : result.status;
      log("warn", "pipeline:stop", {
        reason: result.status,
        step,
        stage: "stage" in result ? result.stage : undefined,
        detail: "reason" in result ? result.reason : undefined,
      });
      endSignal = {
        body: `Matt Auto stopped: ${detail.slice(0, 160)}`,
        warning: true,
      };
      return;
    }

    // Workflow fully delivered — do not auto Create-spec / Follow-up next.
    if (result.status === "completed" && result.stage === "cleanup") {
      const wf =
        "workflowId" in result && typeof result.workflowId === "number"
          ? result.workflowId
          : undefined;
      ui.notify(
        "Workflow cleanup finished. Pipeline stopped — start Create-spec or Follow-up deliberately if needed.",
        "info",
      );
      log("info", "pipeline:stop", {
        reason: "workflow-complete",
        step,
        stage: "cleanup",
        workflowId: wf,
      });
      const completedWorkers = wf
        ? coordinator.getCompletedWorkerTelemetry(wf)
        : [];
      const pipelineElapsedMs = coordinator.getPipelineRunElapsedMs();
      const details = [
        ...(typeof pipelineElapsedMs === "number"
          ? [`Pipeline runtime: ${formatRuntimeMs(pipelineElapsedMs)}`]
          : []),
        ...formatCompletedWorkerTelemetry(completedWorkers),
      ];
      endSignal = {
        body: wf
          ? `Workflow #${wf} complete (cleanup finished). Ready for next steps.`
          : "Matt Auto workflow complete (cleanup finished).",
        ...(details.length > 0 ? { details } : {}),
      };
      return;
    }

    // Implement returns "running" while the worker is live. Do NOT wait yet —
    // continue the loop so remaining free Implementation slots can be filled
    // from the ready frontier (up to N). Wait only when nextActions is empty
    // while workers still run (slots full / frontier empty / P1 blocked).
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
        runningCount: runningWorkers(panel).length,
      });
      continue;
    }
  }

  ui.notify("Pipeline reached step limit — re-run /matt-auto run to continue.", "warning");
  log("warn", "pipeline:stop", { reason: "step-limit" });
  endSignal = {
    body: "Matt Auto pipeline reached step limit — re-run /matt-auto run.",
    warning: true,
  };
  } finally {
    stopPersistentLive = true;
    try {
      await persistentLivePromise;
    } catch {
      // Live surface failures must not mask completion signaling.
    }
    if (endSignal) {
      signalMattAutoComplete(ui, {
        cwd: process.cwd(),
        body: endSignal.body,
        ...(endSignal.details ? { details: endSignal.details } : {}),
        ...(endSignal.warning ? { warning: true } : {}),
        ...(endSignal.title ? { title: endSignal.title } : {}),
      });
    }
  }
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
  const decision = await createFallbackWorkflowActionInteraction(ui).present({
    kind: "implementation-disposition",
    ticketNumber: pending.ticketNumber,
    attempt: pending.attempt,
    branchName: pending.branchName,
    ...(pending.summary ? { summary: pending.summary } : {}),
    choices: IMPLEMENTATION_DISPOSITION_OPTIONS,
  });
  return decision === "close" ||
    decision === "leave-open" ||
    decision === "investigate"
    ? decision
    : undefined;
}

/** Stage confirmation menu for Create-spec: Publish / Revise / Cancel. */
export async function presentStageConfirmation(
  ui: MattAutoUi,
  draft: SpecDraft,
): Promise<StageConfirmationDecision | undefined> {
  const decision = await createFallbackWorkflowActionInteraction(ui).present({
    kind: "stage-confirmation",
    stage: "create-spec",
    draft,
    choices: STAGE_CONFIRMATION_OPTIONS,
  });
  return decision === "publish" || decision === "revise" || decision === "cancel"
    ? decision
    : undefined;
}

/** Stage confirmation menu for Create-tickets: Publish / Revise / Cancel. */
export async function presentTicketsStageConfirmation(
  ui: MattAutoUi,
  draft: TicketsDraft,
): Promise<StageConfirmationDecision | undefined> {
  const decision = await createFallbackWorkflowActionInteraction(ui).present({
    kind: "stage-confirmation",
    stage: "create-tickets",
    draft,
    choices: STAGE_CONFIRMATION_OPTIONS,
  });
  return decision === "publish" || decision === "revise" || decision === "cancel"
    ? decision
    : undefined;
}

function notifyStageResult(ui: MattAutoUi, result: StageResult): void {
  switch (result.status) {
    case "completed":
      if (result.stage === "workflow-routing") {
        ui.notify(
          `Workflow home is now bound to Workflow #${result.workflowId}${result.targetBranch ? ` for ${result.targetBranch}` : ""}.`,
          "info",
        );
        return;
      }
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
        const parentClosed =
          "parentSpecClosed" in result ? result.parentSpecClosed : undefined;
        const parentWarn =
          "parentSpecCloseWarning" in result
            ? result.parentSpecCloseWarning
            : undefined;
        const localPull =
          "localPull" in result ? result.localPull : undefined;
        const pullMsg = localPull?.pulled
          ? `Local branch ${localPull.branch} fast-forwarded to origin${localPull.submodulesUpdated ? " (submodules updated)" : ""}. Please /reload Pi.`
          : localPull?.skipped
            ? `Auto-pull skipped (${localPull.reason ?? "unsafe"}). Run git pull manually if needed, then /reload Pi.`
            : "Please git pull on the Workflow root and /reload Pi to pick up merged work.";
        ui.notify(
          [
            `Workflow cleanup completed for #${result.workflowId}.`,
            result.cleanedLocal && result.cleanedRemote
              ? "Local workspaces/transcripts and remote matt-auto branches removed together."
              : undefined,
            parentClosed === true
              ? `Parent Workflow spec #${result.workflowId} closed.`
              : parentClosed === false
                ? `Parent Workflow spec #${result.workflowId} was not closed${parentWarn ? `: ${parentWarn}` : ""}. Close it manually if needed.`
                : undefined,
            pullMsg,
            result.removedBranches?.length
              ? `Branches: ${result.removedBranches.join(", ")}.`
              : undefined,
          ]
            .filter(Boolean)
            .join(" "),
          parentClosed === false || localPull?.skipped ? "warning" : "info",
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
 * Worker concurrency configuration menus (global + Workflow-root).
 * Writes only Matt Auto preferences. Concurrency warning fires on save when N > 4;
 * run-time slot filling never re-prompts.
 */
export async function presentWorkerConcurrencyMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const [global, root] = await Promise.all([
      coordinator.getGlobalWorkerConcurrency(),
      coordinator.getRootWorkerConcurrency(),
    ]);
    const effective = resolveWorkerConcurrency(root, global);

    const options = [
      formatResolvedWorkerConcurrencyLine(
        effective.concurrency,
        effective.source,
      ),
      `Global default: ${global !== undefined ? String(global) : "(not set)"}`,
      `Workflow-root override: ${root !== undefined ? String(root) : "(not set)"}`,
      SET_GLOBAL_WORKER_CONCURRENCY,
      SET_ROOT_WORKER_CONCURRENCY,
    ];
    if (root !== undefined) {
      options.push(CLEAR_ROOT_WORKER_CONCURRENCY);
    }
    options.push(BACK_ITEM);

    const selected = await ui.select("Worker concurrency", options);
    if (selected === undefined || selected === BACK_ITEM) return;

    if (selected.startsWith("Effective Worker concurrency:")) {
      await notifyWorkerConcurrency(coordinator, ui);
      continue;
    }
    if (selected.startsWith("Global default:")) {
      ui.notify(
        global !== undefined
          ? `Global default Worker concurrency: ${global}`
          : "No global default Worker concurrency is set (effective falls back to default 2).",
        "info",
      );
      continue;
    }
    if (selected.startsWith("Workflow-root override:")) {
      ui.notify(
        root !== undefined
          ? `Workflow-root Worker concurrency override: ${root}`
          : "No Workflow-root Worker concurrency override is set.",
        "info",
      );
      continue;
    }

    if (selected === SET_GLOBAL_WORKER_CONCURRENCY) {
      const value = await promptWorkerConcurrency(ui, "global default");
      if (value === undefined) continue;
      try {
        await coordinator.setGlobalWorkerConcurrency(value);
        ui.notify(
          `Global default Worker concurrency set to ${value}.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === SET_ROOT_WORKER_CONCURRENCY) {
      const value = await promptWorkerConcurrency(
        ui,
        "Workflow-root override",
      );
      if (value === undefined) continue;
      try {
        await coordinator.setRootWorkerConcurrency(value);
        ui.notify(
          `Workflow-root Worker concurrency override set to ${value}.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === CLEAR_ROOT_WORKER_CONCURRENCY) {
      await coordinator.clearRootWorkerConcurrency();
      ui.notify(
        "Cleared Workflow-root Worker concurrency override. Effective Worker concurrency falls back to the global default (or default 2).",
        "info",
      );
    }
  }
}

/**
 * Prompt for Worker concurrency as a positive integer.
 * Invalid input notifies and returns undefined (no write).
 * Values above the Concurrency warning threshold require one confirmation.
 */
export async function promptWorkerConcurrency(
  ui: MattAutoUi,
  layerLabel: string,
): Promise<number | undefined> {
  if (!ui.input) {
    ui.notify(
      "Worker concurrency configuration needs an input UI to enter a positive integer.",
      "warning",
    );
    return undefined;
  }

  const raw = await ui.input(
    `Worker concurrency (${layerLabel}) — positive integer ≥ 1`,
    String(WORKER_CONCURRENCY_WARNING_THRESHOLD),
  );
  if (raw === undefined) return undefined;

  const parsed = parseWorkerConcurrencyInput(raw);
  if (!parsed.ok) {
    ui.notify(parsed.reason, "error");
    return undefined;
  }

  if (needsConcurrencyWarning(parsed.value)) {
    const confirmed = await confirmConcurrencyWarning(ui, parsed.value);
    if (!confirmed) {
      ui.notify(
        "Concurrency warning declined — Worker concurrency preferences unchanged.",
        "info",
      );
      return undefined;
    }
  }

  return parsed.value;
}

/** One confirmation for saving Worker concurrency above the warning threshold. */
export async function confirmConcurrencyWarning(
  ui: MattAutoUi,
  concurrency: number,
): Promise<boolean> {
  ui.notify(concurrencyWarningMessage(concurrency), "warning");
  const selected = await ui.select("Concurrency warning", [
    CONFIRM_CONCURRENCY_WARNING_ITEM,
    DECLINE_CONCURRENCY_WARNING_ITEM,
  ]);
  return selected === CONFIRM_CONCURRENCY_WARNING_ITEM;
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
    const [effective, global, root, active] = await Promise.all([
      coordinator.getWorkerProfile(),
      coordinator.getGlobalWorkerProfile(),
      coordinator.getRootWorkerProfile(),
      coordinator.getActiveWorkflow(),
    ]);

    const options = [
      `Effective: ${effective ? formatProfileShort(effective.profile) + ` [${effective.source}]` : "(not configured)"}`,
      `Global default: ${global ? formatProfileShort(global) : "(not set)"}`,
      `Workflow-root override: ${root ? formatProfileShort(root) : "(not set)"}`,
    ];
    if (active) {
      options.push(
        `Active workflow #${active.workflowId} snapshot: ${formatProfileShort(active.workerProfile)}`,
      );
      options.push(SET_ACTIVE_WORKFLOW_WORKER);
    }
    options.push(SET_GLOBAL_WORKER, SET_ROOT_WORKER);
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
    if (selected.startsWith("Active workflow #")) {
      ui.notify(
        active
          ? [
              `Active workflow #${active.workflowId} Worker profile snapshot: ${formatProfileShort(active.workerProfile)}.`,
              "This snapshot outranks global/root preferences for later tickets in this workflow.",
              `Use "${SET_ACTIVE_WORKFLOW_WORKER}" to change it on the Workflow manifest.`,
            ].join("\n")
          : "No Active workflow snapshot is loaded.",
        "info",
      );
      continue;
    }

    if (selected === SET_ACTIVE_WORKFLOW_WORKER) {
      const profile = await promptWorkerProfile(coordinator, ui);
      if (!profile) continue;
      try {
        await coordinator.setActiveWorkflowWorkerProfile(profile);
        ui.notify(
          `Active workflow Worker profile snapshot set to ${formatProfileShort(profile)}. Later Implementation workers use this model; Workflow home model is unchanged.`,
          "info",
        );
      } catch (error) {
        ui.notify(errorMessage(error), "error");
      }
      continue;
    }

    if (selected === SET_GLOBAL_WORKER) {
      const profile = await promptWorkerProfile(coordinator, ui);
      if (!profile) continue;
      try {
        await coordinator.setGlobalWorkerProfile(profile);
        const stillSnapshotted =
          (await coordinator.getWorkerProfile())?.source === "workflow-snapshot";
        ui.notify(
          stillSnapshotted
            ? `Global default Worker profile set to ${formatProfileShort(profile)}. Effective profile still comes from the Active workflow snapshot — use "${SET_ACTIVE_WORKFLOW_WORKER}" to change this workflow.`
            : `Global default Worker profile set to ${formatProfileShort(profile)}. Workflow home model is unchanged.`,
          stillSnapshotted ? "warning" : "info",
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
        const stillSnapshotted =
          (await coordinator.getWorkerProfile())?.source === "workflow-snapshot";
        ui.notify(
          stillSnapshotted
            ? `Workflow-root Worker profile override set to ${formatProfileShort(profile)}. Effective profile still comes from the Active workflow snapshot — use "${SET_ACTIVE_WORKFLOW_WORKER}" to change this workflow.`
            : `Workflow-root Worker profile override set to ${formatProfileShort(profile)}. Workflow home model is unchanged.`,
          stillSnapshotted ? "warning" : "info",
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
  if (await presentDashboardIfAvailable(coordinator, ui, "next-actions")) {
    return;
  }

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

async function notifyWorkerConcurrency(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  const [global, root] = await Promise.all([
    coordinator.getGlobalWorkerConcurrency(),
    coordinator.getRootWorkerConcurrency(),
  ]);
  const effective = resolveWorkerConcurrency(root, global);
  const lines = [
    `Effective Worker concurrency: ${effective.concurrency} [${effective.source}]`,
    `Global default: ${global !== undefined ? String(global) : "(not set)"}`,
    `Workflow-root override: ${root !== undefined ? String(root) : "(not set)"}`,
    `Concurrency warning threshold: ${WORKER_CONCURRENCY_WARNING_THRESHOLD} (confirm when saving above this; no re-prompt during /matt-auto run).`,
  ];
  ui.notify(lines.join("\n"), "info");
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
