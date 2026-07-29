import {
  formatParallelDeliveryBriefLines,
  formatParallelDeliveryWaitingState,
} from "../parallel-delivery-state.js";
import type {
  RunTerminationMode,
  WorkflowPanelState,
} from "../types.js";

/**
 * Predict Run termination mode (T1 stop-only vs T2 discard) from panel facts.
 * Mirrors coordinator late-stage rule: integrated work or Workflow PR ⇒ stop-only.
 * Used only for confirmation copy before `terminateRun()` decides authoritatively.
 */
export function predictRunTerminationMode(
  panel: WorkflowPanelState,
): RunTerminationMode {
  if (panel.workflowPr) return "stop-only";
  if (panel.ci && panel.ci.length > 0) return "stop-only";
  if (panel.ticketProgress) {
    if (panel.ticketProgress.closed > 0) return "stop-only";
    if (panel.ticketProgress.awaitingCi.length > 0) return "stop-only";
  }
  return "discard-unintegrated";
}

/** Section ids for the full-screen run brief (display only). */
export type RunBriefSectionId =
  | "workflow"
  | "pipeline"
  | "context"
  | "parallel-delivery"
  | "workers"
  | "recovery"
  | "integration"
  | "ci"
  | "workflow-pr"
  | "tickets"
  | "controls"
  | "stop";

/** One labeled block of operator-facing brief lines. */
export type RunBriefSection = {
  id: RunBriefSectionId;
  title: string;
  lines: readonly string[];
};

/**
 * Structured run brief view-model derived from Workflow panel state.
 * Pure display data — no controls, no GitHub writes.
 */
export type RunBriefViewModel = {
  sections: readonly RunBriefSection[];
  /** Flat lines ready for multi-line notify / full-screen text. */
  lines: readonly string[];
};

type PanelWorker = WorkflowPanelState["workers"][number];

type CompletedWorkerRun = NonNullable<
  WorkflowPanelState["completedWorkerRuns"]
>[number];

/** Exact Pi model selector that was passed when a worker was launched. */
export function formatWorkerModel(
  profile: PanelWorker["workerProfile"],
): string | undefined {
  if (!profile) return undefined;
  const provider = profile.provider.trim();
  const modelId = profile.modelId.trim();
  const thinkingLevel = profile.thinkingLevel.trim();
  if (!provider || !modelId || !thinkingLevel) return undefined;
  return `${provider}/${modelId}:${thinkingLevel}`;
}

/** Exact UTC clock time plus live elapsed age for Pi's latest turn_start. */
export function formatLastTurnStartedAt(
  timestampMs: number | undefined,
  nowMs = Date.now(),
): string {
  if (
    typeof timestampMs !== "number" ||
    !Number.isFinite(timestampMs) ||
    timestampMs < 0
  ) {
    return "—";
  }
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return "—";
  const clock = date.toISOString().slice(11, 19);
  return `${clock}Z (${formatRuntimeMs(Math.max(0, nowMs - timestampMs))} ago)`;
}

/** Per-worker Pi turn telemetry; never sums concurrent worker conversations. */
export function formatWorkerTurnSummary(
  worker: PanelWorker,
  nowMs = Date.now(),
): string | undefined {
  if (
    typeof worker.turnCount !== "number" &&
    typeof worker.lastTurnStartedAtMs !== "number"
  ) {
    return undefined;
  }
  const turns =
    typeof worker.turnCount === "number" && worker.turnCount >= 0
      ? String(worker.turnCount)
      : "—";
  return `turns: ${turns} · last turn: ${formatLastTurnStartedAt(worker.lastTurnStartedAtMs, nowMs)}`;
}

export type BuildRunBriefOptions = {
  /**
   * When true, omit the textual Controls section (live custom UI already hosts
   * Pause/Terminate SelectList — avoid a second Controls block).
   */
  omitControls?: boolean;
};

/**
 * Map `getPanelState()` DTO → structured run brief sections.
 * Missing optional fields are omitted (never throw, never invent values).
 */
export function buildRunBriefViewModel(
  panel: WorkflowPanelState,
  options: BuildRunBriefOptions = {},
): RunBriefViewModel {
  const sections: RunBriefSection[] = [];

  sections.push(workflowSection(panel));
  sections.push(pipelineSection(panel));

  const context = contextSection(panel);
  if (context) sections.push(context);

  const parallelDelivery = parallelDeliverySection(panel);
  if (parallelDelivery) sections.push(parallelDelivery);

  const hasTicketTable = Boolean(
    panel.ticketProgress &&
      (panel.ticketProgress.items?.length ||
        panel.ticketProgress.total > 0),
  );
  const workers = workersSection(panel.workers, hasTicketTable);
  if (workers) sections.push(workers);

  const recovery = implementationRecoverySection(panel);
  if (recovery) sections.push(recovery);

  const integration = integrationSection(panel.integration);
  if (integration) sections.push(integration);

  const ci = ciSection(panel.ci);
  if (ci) sections.push(ci);

  const workflowPr = workflowPrSection(panel.workflowPr);
  if (workflowPr) sections.push(workflowPr);

  const tickets = ticketsSection(panel);
  if (tickets) sections.push(tickets);

  if (!options.omitControls) {
    const controls = controlsSection(panel);
    if (controls) sections.push(controls);
  }

  const stop = stopSection(panel);
  if (stop) sections.push(stop);

  return {
    sections,
    lines: formatRunBriefLines({ sections }),
  };
}

/** Flatten a run brief view-model into display lines. */
export function formatRunBriefLines(brief: {
  sections: readonly RunBriefSection[];
}): string[] {
  const out: string[] = [];
  for (const section of brief.sections) {
    if (out.length > 0) out.push("");
    out.push(section.title);
    for (const line of section.lines) {
      out.push(line);
    }
  }
  return out;
}

function workflowSection(panel: WorkflowPanelState): RunBriefSection {
  const title = panel.title?.trim();
  const identity = title
    ? `Workflow #${panel.workflowId}: ${title}`
    : `Workflow #${panel.workflowId}`;
  return {
    id: "workflow",
    title: "Workflow",
    lines: [identity],
  };
}

function pipelineSection(panel: WorkflowPanelState): RunBriefSection {
  let status: string;
  if (panel.runTerminated) {
    status = "terminated";
  } else if (panel.pipelinePaused) {
    status = "paused";
  } else {
    status = "running";
  }
  const lines = [`Status: ${status}`];
  if (typeof panel.runElapsedMs === "number") {
    lines.push(`Elapsed: ${formatRuntimeMs(panel.runElapsedMs)}`);
  }
  return {
    id: "pipeline",
    title: "Pipeline",
    lines,
  };
}

function contextSection(
  panel: WorkflowPanelState,
): RunBriefSection | undefined {
  const label = deriveContextLabel(panel);
  if (!label) return undefined;
  return {
    id: "context",
    title: "Context",
    lines: [label],
  };
}

/**
 * Best-effort stage / next-context label from panel facts already present.
 * Prefer concrete worker/integration/CI/PR state over generic pipeline flags.
 */
export function deriveContextLabel(panel: WorkflowPanelState): string | undefined {
  if (panel.createTicketsPublishInProgress) {
    return "Publishing tickets…";
  }
  const running = panel.workers.filter((w) => w.status === "running");
  if (running.length > 0) {
    const first = running[0]!;
    return `Implementing #${first.ticketNumber} r${first.attempt}`;
  }

  const needsDisposition = panel.workers.filter(
    (w) => w.status === "needs-disposition",
  );
  if (needsDisposition.length > 0) {
    const first = needsDisposition[0]!;
    return `Needs disposition #${first.ticketNumber} r${first.attempt}`;
  }

  if (panel.integration?.status === "conflict-resolution") {
    return `Conflict resolution #${panel.integration.ticketNumber} r${panel.integration.attempt}`;
  }
  if (panel.integration?.status === "running") {
    return `Integrating #${panel.integration.ticketNumber} r${panel.integration.attempt}`;
  }
  if (panel.integration?.status === "pending-retry") {
    return `Integration pending retry #${panel.integration.ticketNumber} r${panel.integration.attempt}`;
  }

  const ciFailure = panel.ci?.find((c) => c.status === "failure");
  if (ciFailure) {
    return `CI recovery #${ciFailure.ticketNumber} r${ciFailure.attempt}`;
  }
  const ciAwaiting = panel.ci?.filter((c) => c.status === "awaiting-check") ?? [];
  if (ciAwaiting.length > 0) {
    const list = ciAwaiting.map((c) => `#${c.ticketNumber}`).join(", ");
    return `Awaiting CI: ${list}`;
  }

  // Prefer observed parallel-delivery waiting state over generic PR labels
  // so queue / refresh / retry / lost-lease remain distinguishable.
  if (
    panel.parallelDelivery &&
    panel.parallelDelivery.waitingState !== "not-in-delivery"
  ) {
    return formatParallelDeliveryWaitingState(
      panel.parallelDelivery.waitingState,
    );
  }

  if (panel.workflowPr?.status === "merged") {
    return `Workflow PR #${panel.workflowPr.number} merged (cleanup pending)`;
  }
  if (panel.workflowPr?.status === "open") {
    return `Workflow PR #${panel.workflowPr.number} open`;
  }

  if (panel.pipelinePaused) return "Pipeline paused";
  if (panel.runTerminated) return "Run terminated";

  if (panel.ticketProgress && panel.ticketProgress.ready.length > 0) {
    const freeReady = freeReadyFrontierTickets(panel);
    if (freeReady.length === 0) return undefined;
    const list = freeReady.map((t) => `#${t.number}`).join(", ");
    return `Ready frontier: ${list}`;
  }

  return undefined;
}

/**
 * Tracker ready tickets that are not already occupied by a session worker
 * (running, needs-disposition, recovery, etc.). Used so Ready frontier and
 * READY/BLOCK do not contradict live STATUS.
 */
export function freeReadyFrontierTickets(
  panel: WorkflowPanelState,
): readonly { number: number; title: string }[] {
  const ready = panel.ticketProgress?.ready ?? [];
  if (ready.length === 0) return [];
  const integratingTicket = panel.integration?.ticketNumber;
  return ready.filter((ticket) => {
    if (
      integratingTicket !== undefined &&
      ticket.number === integratingTicket
    ) {
      return false;
    }
    const worker = panel.workers.find((w) => w.ticketNumber === ticket.number);
    if (!worker) return true;
    return !sessionOccupiesReadySlot(worker.status);
  });
}

function sessionOccupiesReadySlot(status: PanelWorker["status"]): boolean {
  return (
    status === "running" ||
    status === "needs-disposition" ||
    status === "compatibility-recovery" ||
    status === "failed" ||
    status === "aborted"
  );
}

function parallelDeliverySection(
  panel: WorkflowPanelState,
): RunBriefSection | undefined {
  if (!panel.parallelDelivery) return undefined;
  return {
    id: "parallel-delivery",
    title: "Parallel delivery",
    lines: formatParallelDeliveryBriefLines(panel.parallelDelivery),
  };
}

function workersSection(
  workers: WorkflowPanelState["workers"],
  /** When true, ticket table already carries status — keep Workers to one line each. */
  compact = false,
): RunBriefSection | undefined {
  if (workers.length === 0) return undefined;
  const lines: string[] = [];
  for (const worker of workers) {
    lines.push(...formatWorkerLines(worker, compact));
  }
  return {
    id: "workers",
    title: "Workers",
    lines,
  };
}

function formatWorkerLines(worker: PanelWorker, compact: boolean): string[] {
  const head = `#${worker.ticketNumber} r${worker.attempt}: ${worker.status}`;
  const model = formatWorkerModel(worker.workerProfile);
  const turnSummary = formatWorkerTurnSummary(worker);
  // Stale implement progress is misleading once the worker is no longer running.
  const showProgress =
    Boolean(worker.progress?.trim()) && worker.status === "running";
  if (compact) {
    // Paths/ids live in logs; table already shows status/runtime.
    const withModel = model ? `${head} · model=${model}` : head;
    const lines = [
      showProgress ? `${withModel} — ${worker.progress!.trim()}` : withModel,
    ];
    if (turnSummary) lines.push(`  ${turnSummary}`);
    return lines;
  }
  const lines = [head];
  if (model) {
    lines.push(`  model: ${model}`);
  }
  if (turnSummary) {
    lines.push(`  ${turnSummary}`);
  }
  if (worker.workerId) {
    lines.push(`  workerId: ${worker.workerId}`);
  }
  if (typeof worker.pid === "number") {
    lines.push(`  pid: ${worker.pid}`);
  }
  if (typeof worker.processAlive === "boolean") {
    lines.push(`  processAlive: ${worker.processAlive}`);
  }
  if (worker.branchName) {
    lines.push(`  branch: ${worker.branchName}`);
  }
  if (worker.worktreePath) {
    lines.push(`  worktree: ${worker.worktreePath}`);
  }
  if (worker.transcriptPath) {
    lines.push(`  transcript: ${worker.transcriptPath}`);
  }
  if (showProgress) {
    lines.push(`  progress: ${worker.progress}`);
  }
  return lines;
}

/** Keep conflict reasons short in the brief — multi-page git dump can stall/crash the TUI. */
export function formatIntegrationReasonForBrief(
  reason: string,
  maxLen = 180,
): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

function implementationRecoverySection(
  panel: WorkflowPanelState,
  nowMs: number = Date.now(),
): RunBriefSection | undefined {
  const recovery = panel.implementationRecovery;
  if (!recovery || recovery.length === 0) return undefined;
  const lines = recovery.map((entry) => {
    const remainingMs = Math.max(0, entry.untilMs - nowMs);
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const until = new Date(entry.untilMs).toISOString().slice(11, 16) + "Z";
    const reason = entry.reason ? ` — ${entry.reason}` : "";
    return `#${entry.ticketNumber}: cooling ~${minutes}m (until ${until})${reason}`;
  });
  return {
    id: "recovery",
    title: "Implementation recovery",
    lines: [
      "Auto Implement withheld after Compatibility recovery:",
      ...lines,
    ],
  };
}

function integrationSection(
  integration: WorkflowPanelState["integration"],
): RunBriefSection | undefined {
  if (!integration) return undefined;
  const lines = [
    `#${integration.ticketNumber} r${integration.attempt}: ${integration.status}`,
    `  branch: ${integration.branchName}`,
  ];
  // Live elapsed while the unit is running (matches Pipeline Elapsed cadence).
  if (
    integration.status === "running" &&
    typeof integration.runtimeMs === "number"
  ) {
    lines.push(`  elapsed: ${formatRuntimeMs(integration.runtimeMs)}`);
  }
  // Only show reason for retry/conflict surfaces — not while a fresh unit runs
  // (stale lastFailure freezes the brief as if the current attempt already failed).
  if (integration.reason && integration.status !== "running") {
    lines.push(
      `  reason: ${formatIntegrationReasonForBrief(integration.reason)}`,
    );
  } else if (
    integration.reason &&
    integration.status === "running" &&
    !integration.reason.includes("failed")
  ) {
    // Informational running labels (e.g. "Target-branch refresh") stay visible.
    lines.push(
      `  reason: ${formatIntegrationReasonForBrief(integration.reason)}`,
    );
  }
  return {
    id: "integration",
    title: "Integration",
    lines,
  };
}

function ciSection(
  ci: WorkflowPanelState["ci"],
): RunBriefSection | undefined {
  if (!ci || ci.length === 0) return undefined;
  const lines: string[] = [];
  for (const entry of ci) {
    lines.push(`#${entry.ticketNumber} r${entry.attempt}: ${entry.status}`);
    lines.push(`  integrationBranch: ${entry.integrationBranch}`);
    if (entry.summary) {
      lines.push(`  summary: ${entry.summary}`);
    }
    if (entry.url) {
      lines.push(`  url: ${entry.url}`);
    }
  }
  return {
    id: "ci",
    title: "CI",
    lines,
  };
}

function workflowPrSection(
  workflowPr: WorkflowPanelState["workflowPr"],
): RunBriefSection | undefined {
  if (!workflowPr) return undefined;
  const lines = [
    `PR #${workflowPr.number}: ${workflowPr.status}`,
    `  ${workflowPr.headBranch} → ${workflowPr.baseBranch}`,
  ];
  if (workflowPr.url) {
    lines.push(`  url: ${workflowPr.url}`);
  }
  return {
    id: "workflow-pr",
    title: "Workflow PR",
    lines,
  };
}

/** Column widths for monospaced ticket table (S1 by #, six columns). */
const COL = {
  num: 6,
  ready: 18,
  // Wide enough for `10m30s(59s)` / `1h05m(12m00s)` live turn suffix.
  runtime: 14,
  turns: 8,
  status: 16,
  title: 32,
} as const;

/**
 * List every workflow issue as an aligned table:
 * # | READY/BLOCK | RUNTIME | TURNS | STATUS | TITLE
 * Sort: issue number ascending (S1).
 * Runtime/turns prefer a live worker, then the latest successful Implementation attempt.
 */
function ticketsSection(
  panel: WorkflowPanelState,
): RunBriefSection | undefined {
  const progress = panel.ticketProgress;
  if (!progress) return undefined;

  const freeReadyCount = freeReadyFrontierTickets(panel).length;
  const trackerReadyCount = progress.ready.length;
  const readySummary =
    freeReadyCount === trackerReadyCount
      ? `${trackerReadyCount} ready`
      : `${freeReadyCount} free ready (${trackerReadyCount} tracker ready)`;
  const lines = [
    `Summary: ${readySummary} / ${progress.open} open / ${progress.closed} closed (total ${progress.total})`,
  ];

  const items =
    progress.items && progress.items.length > 0
      ? [...progress.items].sort((a, b) => a.number - b.number)
      : synthesizeItemsFromBuckets(progress);

  if (items.length === 0) {
    return { id: "tickets", title: "Tickets", lines };
  }

  lines.push(formatTicketTableHeader());
  lines.push(formatTicketTableRule());
  for (const item of items) {
    lines.push(formatTicketTableRow(item, panel));
  }

  return {
    id: "tickets",
    title: "Tickets",
    lines,
  };
}

export function formatRuntimeMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, "0")}m`;
}

/**
 * Total attempt runtime, optionally with the current turn duration in parens.
 * Example: `10m30s(30s)` = 10m30s wall clock, 30s since latest turn_start.
 */
export function formatRuntimeWithTurnMs(
  runtimeMs: number | undefined,
  lastTurnStartedAtMs: number | undefined,
  nowMs = Date.now(),
): string {
  const total = formatRuntimeMs(runtimeMs);
  if (total === "—") return total;
  if (
    typeof lastTurnStartedAtMs !== "number" ||
    !Number.isFinite(lastTurnStartedAtMs) ||
    lastTurnStartedAtMs < 0
  ) {
    return total;
  }
  const turnMs = Math.max(0, nowMs - lastTurnStartedAtMs);
  return `${total}(${formatRuntimeMs(turnMs)})`;
}

function padCell(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return text.padEnd(width, " ");
}

export function formatTicketTableHeader(): string {
  return [
    padCell("#", COL.num),
    padCell("READY/BLOCK", COL.ready),
    padCell("RUNTIME", COL.runtime),
    padCell("TURNS", COL.turns),
    padCell("STATUS", COL.status),
    padCell("TITLE", COL.title),
  ].join(" ");
}

export function formatTicketTableRule(): string {
  return [
    "-".repeat(COL.num),
    "-".repeat(COL.ready),
    "-".repeat(COL.runtime),
    "-".repeat(COL.turns),
    "-".repeat(COL.status),
    "-".repeat(COL.title),
  ].join(" ");
}

function synthesizeItemsFromBuckets(
  progress: NonNullable<WorkflowPanelState["ticketProgress"]>,
): NonNullable<WorkflowPanelState["ticketProgress"]>["items"][number][] {
  const items: NonNullable<
    WorkflowPanelState["ticketProgress"]
  >["items"][number][] = [];
  for (const t of progress.ready) {
    items.push({
      number: t.number,
      title: t.title,
      state: "OPEN",
      status: "ready",
    });
  }
  for (const t of progress.blocked) {
    items.push({
      number: t.number,
      title: t.title,
      state: "OPEN",
      status: "blocked",
      openBlockers: t.openBlockers,
    });
  }
  for (const t of progress.awaitingCi) {
    items.push({
      number: t.number,
      title: t.title,
      state: "OPEN",
      status: "awaiting-ci",
    });
  }
  return items.sort((a, b) => a.number - b.number);
}

function latestCompletedImplementationRun(
  panel: WorkflowPanelState,
  ticketNumber: number,
): CompletedWorkerRun | undefined {
  return (panel.completedWorkerRuns ?? [])
    .filter(
      (run) =>
        run.ticketNumber === ticketNumber && run.kind === "implementation",
    )
    .sort((a, b) => b.attempt - a.attempt)[0];
}

export function formatTicketTableRow(
  item: NonNullable<
    WorkflowPanelState["ticketProgress"]
  >["items"][number],
  panel: WorkflowPanelState,
): string {
  const worker = panel.workers.find((w) => w.ticketNumber === item.number);
  const integration =
    panel.integration?.ticketNumber === item.number
      ? panel.integration
      : undefined;
  const ci = panel.ci?.find((c) => c.ticketNumber === item.number);
  const completedRun = latestCompletedImplementationRun(panel, item.number);
  // Prefer the live panel worker while the attempt is still in the pipeline
  // (running / needs-disposition / recovery). completedWorkerRuns freezes
  // runtimeMs at process exit and made the ticket list look stuck while
  // Pipeline Elapsed kept ticking.
  const liveSessionWorker =
    worker &&
    (worker.status === "running" ||
      worker.status === "needs-disposition" ||
      worker.status === "compatibility-recovery")
      ? worker
      : undefined;
  const telemetry = liveSessionWorker ?? completedRun ?? worker;

  // READY/BLOCK: session lifecycle overlays tracker frontier so the column
  // never says "ready" while STATUS is needs-disp / running / integrating.
  let readyBlock = "—";
  if (integration) {
    if (integration.status === "running") readyBlock = "integrating";
    else if (integration.status === "pending-retry") readyBlock = "int-retry";
    else if (integration.status === "conflict-resolution") readyBlock = "conflict";
    else readyBlock = integration.status;
  } else if (worker && sessionOccupiesReadySlot(worker.status)) {
    if (worker.status === "needs-disposition") readyBlock = "needs-disp";
    else if (worker.status === "running") readyBlock = "running";
    else if (worker.status === "compatibility-recovery") readyBlock = "recovery";
    else if (worker.status === "failed") readyBlock = "failed";
    else if (worker.status === "aborted") readyBlock = "aborted";
    else readyBlock = worker.status;
  } else if (item.status === "ready") readyBlock = "ready";
  else if (item.status === "blocked") {
    readyBlock = item.openBlockers?.length
      ? `blocked by ${item.openBlockers.map((n) => `#${n}`).join(",")}`
      : "blocked";
  } else if (item.status === "awaiting-ci") {
    readyBlock = "ready"; // integrated open tickets were ready to implement
  }

  // Prefer live Integration elapsed while that ticket's unit is running.
  const runtimeMs =
    integration?.status === "running" && typeof integration.runtimeMs === "number"
      ? integration.runtimeMs
      : telemetry?.runtimeMs;
  // Current-turn suffix only while Implementation is still running (live turn_start).
  const lastTurnStartedAtMs =
    worker?.status === "running" &&
    typeof worker.lastTurnStartedAtMs === "number"
      ? worker.lastTurnStartedAtMs
      : undefined;
  const runtime = formatRuntimeWithTurnMs(runtimeMs, lastTurnStartedAtMs);
  const turns =
    typeof telemetry?.turnCount === "number" ? String(telemetry.turnCount) : "—";
  const attempt = telemetry?.attempt;

  // STATUS: lifecycle / live overlay.
  let status: string = item.status;
  if (item.status === "closed" || item.state === "CLOSED") {
    status = attempt === undefined ? "closed" : `closed r${attempt}`;
  } else if (worker) {
    if (worker.status === "needs-disposition") {
      status = `needs-disp r${worker.attempt}`;
    } else if (item.status === "blocked" && worker.status === "running") {
      // Stale: launched while ready, then an upstream blocker reopened.
      status = `stale-block r${worker.attempt}`;
    } else {
      status = `${worker.status} r${worker.attempt}`;
    }
  } else if (integration) {
    status = `integrating r${integration.attempt}`;
  } else if (ci) {
    status = `ci:${ci.status} r${ci.attempt}`;
  } else if (item.status === "awaiting-ci") {
    status = "awaiting-ci";
  } else if (item.status === "ready") {
    status = "ready";
  } else if (item.status === "blocked") {
    status = "blocked";
  }

  const title = item.title.trim() || "(no title)";

  return [
    padCell(`#${item.number}`, COL.num),
    padCell(readyBlock, COL.ready),
    padCell(runtime, COL.runtime),
    padCell(turns, COL.turns),
    padCell(status, COL.status),
    padCell(title, COL.title),
  ].join(" ");
}

/** Always-visible operator stop surface while a run is live. */
function controlsSection(panel: WorkflowPanelState): RunBriefSection | undefined {
  if (panel.runTerminated) return undefined;
  if (panel.pipelinePaused) {
    return {
      id: "controls",
      title: "Controls",
      lines: [
        "Paused — Resume pipeline… / Terminate run… (bound workflow only); Esc returns to chat",
        "Resume later: /matt-auto resume",
        "Emergency stop (repository-scoped) is a separate confirmed control",
        "Shell fallback: echo terminate-now > .pi/matt-auto/run-control",
      ],
    };
  }
  return {
    id: "controls",
    title: "Controls",
    lines: [
      "Live: ↑↓ / Enter on Pause or Terminate (bound workflow only; brief keeps refreshing)",
      "Emergency stop (repository-scoped) is a separate confirmed control",
      "Shell fallback: echo terminate-now > .pi/matt-auto/run-control",
    ],
  };
}

function stopSection(
  panel: WorkflowPanelState,
): RunBriefSection | undefined {
  if (!panel.lastStopReason && !panel.runTerminated && !panel.terminationMode) {
    return undefined;
  }
  const lines: string[] = [];
  if (panel.lastStopReason === "pipeline-pause") {
    lines.push("Last stop: pipeline pause");
  } else if (panel.lastStopReason === "run-termination") {
    lines.push("Last stop: run termination");
  } else if (panel.lastStopReason === "emergency-stop") {
    lines.push("Last stop: emergency stop (repository-scoped)");
  }
  if (panel.terminationMode === "stop-only") {
    lines.push("Termination mode: stop-only (integrated history preserved)");
  } else if (panel.terminationMode === "discard-unintegrated") {
    lines.push("Termination mode: discard unintegrated attempts");
  }
  if (panel.runTerminated && !panel.lastStopReason) {
    lines.push("Run terminated");
  }
  if (lines.length === 0) return undefined;
  return {
    id: "stop",
    title: "Stop reason",
    lines,
  };
}
