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
  | "workers"
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

/**
 * Map `getPanelState()` DTO → structured run brief sections.
 * Missing optional fields are omitted (never throw, never invent values).
 */
export function buildRunBriefViewModel(
  panel: WorkflowPanelState,
): RunBriefViewModel {
  const sections: RunBriefSection[] = [];

  sections.push(workflowSection(panel));
  sections.push(pipelineSection(panel));

  const context = contextSection(panel);
  if (context) sections.push(context);

  const hasTicketTable = Boolean(
    panel.ticketProgress &&
      (panel.ticketProgress.items?.length ||
        panel.ticketProgress.total > 0),
  );
  const workers = workersSection(panel.workers, hasTicketTable);
  if (workers) sections.push(workers);

  const integration = integrationSection(panel.integration);
  if (integration) sections.push(integration);

  const ci = ciSection(panel.ci);
  if (ci) sections.push(ci);

  const workflowPr = workflowPrSection(panel.workflowPr);
  if (workflowPr) sections.push(workflowPr);

  const tickets = ticketsSection(panel);
  if (tickets) sections.push(tickets);

  const controls = controlsSection(panel);
  if (controls) sections.push(controls);

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
  return {
    id: "pipeline",
    title: "Pipeline",
    lines: [`Status: ${status}`],
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

  if (panel.workflowPr?.status === "merged") {
    return `Workflow PR #${panel.workflowPr.number} merged (cleanup pending)`;
  }
  if (panel.workflowPr?.status === "open") {
    return `Workflow PR #${panel.workflowPr.number} open`;
  }

  if (panel.pipelinePaused) return "Pipeline paused";
  if (panel.runTerminated) return "Run terminated";

  if (panel.ticketProgress && panel.ticketProgress.ready.length > 0) {
    const list = panel.ticketProgress.ready
      .map((t) => `#${t.number}`)
      .join(", ");
    return `Ready frontier: ${list}`;
  }

  return undefined;
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
  if (compact) {
    // Paths/ids live in logs; table already shows status/runtime.
    if (worker.progress) {
      return [`${head} — ${worker.progress}`];
    }
    return [head];
  }
  const lines = [head];
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
  if (worker.progress) {
    lines.push(`  progress: ${worker.progress}`);
  }
  return lines;
}

function integrationSection(
  integration: WorkflowPanelState["integration"],
): RunBriefSection | undefined {
  if (!integration) return undefined;
  const lines = [
    `#${integration.ticketNumber} r${integration.attempt}: ${integration.status}`,
    `  branch: ${integration.branchName}`,
  ];
  if (integration.reason) {
    lines.push(`  reason: ${integration.reason}`);
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

/** Column widths for monospaced ticket table (S1 by #, five columns). */
const COL = {
  num: 6,
  ready: 18,
  runtime: 8,
  status: 16,
  title: 36,
} as const;

/**
 * List every workflow issue as an aligned table:
 * # | READY/BLOCK | RUNTIME | STATUS | TITLE
 * Sort: issue number ascending (S1).
 * RUNTIME: R1 current attempt elapsed (from panel worker.runtimeMs).
 */
function ticketsSection(
  panel: WorkflowPanelState,
): RunBriefSection | undefined {
  const progress = panel.ticketProgress;
  if (!progress) return undefined;

  const lines = [
    `Summary: ${progress.ready.length} ready / ${progress.open} open / ${progress.closed} closed (total ${progress.total})`,
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

function padCell(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return text.padEnd(width, " ");
}

export function formatTicketTableHeader(): string {
  return [
    padCell("#", COL.num),
    padCell("READY/BLOCK", COL.ready),
    padCell("RUNTIME", COL.runtime),
    padCell("STATUS", COL.status),
    padCell("TITLE", COL.title),
  ].join(" ");
}

export function formatTicketTableRule(): string {
  return [
    "-".repeat(COL.num),
    "-".repeat(COL.ready),
    "-".repeat(COL.runtime),
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

  // READY/BLOCK: tracker frontier only (not covered by running).
  let readyBlock = "—";
  if (item.status === "ready") readyBlock = "ready";
  else if (item.status === "blocked") {
    readyBlock = item.openBlockers?.length
      ? `blocked by ${item.openBlockers.map((n) => `#${n}`).join(",")}`
      : "blocked";
  } else if (item.status === "awaiting-ci") {
    readyBlock = "ready"; // integrated open tickets were ready to implement
  }

  // RUNTIME: R1 current attempt only.
  const runtime = formatRuntimeMs(worker?.runtimeMs);

  // STATUS: lifecycle / live overlay.
  let status: string = item.status;
  if (item.status === "closed" || item.state === "CLOSED") {
    status = "closed";
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
        "Paused — choose Resume or Terminate in the control menu.",
        "Shortcuts: Ctrl+Alt+M (menu) · Ctrl+Alt+T (terminate)",
        "Shell: echo terminate > .pi/matt-auto/run-control",
        "Emergency (no confirm): echo terminate-now > .pi/matt-auto/run-control",
      ],
    };
  }
  return {
    id: "controls",
    title: "Controls",
    lines: [
      "Ctrl+Alt+M — open Pause / Terminate menu (confirm required)",
      "Ctrl+Alt+P — Pause · Ctrl+Alt+T — Terminate (confirm required)",
      "Shell: echo terminate > .pi/matt-auto/run-control",
      "Emergency (no confirm): echo terminate-now > .pi/matt-auto/run-control",
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
