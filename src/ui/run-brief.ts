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

  const workers = workersSection(panel.workers);
  if (workers) sections.push(workers);

  const integration = integrationSection(panel.integration);
  if (integration) sections.push(integration);

  const ci = ciSection(panel.ci);
  if (ci) sections.push(ci);

  const workflowPr = workflowPrSection(panel.workflowPr);
  if (workflowPr) sections.push(workflowPr);

  const tickets = ticketsSection(panel);
  if (tickets) sections.push(tickets);

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
): RunBriefSection | undefined {
  if (workers.length === 0) return undefined;
  const lines: string[] = [];
  for (const worker of workers) {
    lines.push(...formatWorkerLines(worker));
  }
  return {
    id: "workers",
    title: "Workers",
    lines,
  };
}

function formatWorkerLines(worker: PanelWorker): string[] {
  const lines = [
    `#${worker.ticketNumber} r${worker.attempt}: ${worker.status}`,
  ];
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

/**
 * List every workflow issue with status. Live workers / integration / CI
 * overlays refine tracker status when present.
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
      ? progress.items
      : synthesizeItemsFromBuckets(progress);

  if (items.length === 0) {
    return { id: "tickets", title: "Tickets", lines };
  }

  lines.push("Issues:");
  for (const item of items) {
    lines.push(formatTicketListLine(item, panel));
  }

  return {
    id: "tickets",
    title: "Tickets",
    lines,
  };
}

function synthesizeItemsFromBuckets(
  progress: NonNullable<WorkflowPanelState["ticketProgress"]>,
): NonNullable<WorkflowPanelState["ticketProgress"]>["items"][number][] {
  // Backward-compatible fallback when older fixtures omit `items`.
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

function formatTicketListLine(
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

  let statusLabel: string = item.status;
  let extra = "";

  // Closed GitHub issues stay "closed" even if stale CI rows remain on panel.
  if (item.status === "closed" || item.state === "CLOSED") {
    statusLabel = "closed";
  } else if (worker) {
    statusLabel = worker.status;
    extra = ` r${worker.attempt}`;
    if (worker.progress) {
      extra += ` — ${worker.progress}`;
    }
  } else if (integration) {
    statusLabel = `integration:${integration.status}`;
    extra = ` r${integration.attempt}`;
    if (integration.reason) {
      extra += ` — ${integration.reason}`;
    }
  } else if (ci) {
    statusLabel = `ci:${ci.status}`;
    extra = ` r${ci.attempt}`;
    if (ci.summary) {
      extra += ` — ${ci.summary}`;
    }
  } else if (item.status === "blocked" && item.openBlockers?.length) {
    extra = ` (by ${item.openBlockers.map((n) => `#${n}`).join(", ")})`;
  }

  const title = item.title.trim() || "(no title)";
  return `  #${item.number} [${statusLabel}${extra}] ${title}`;
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
