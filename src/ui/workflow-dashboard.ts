import type {
  NextAction,
  PreflightCheckId,
  PreflightResult,
  TicketProgressItem,
  TicketProgressSummary,
  WorkflowPanelState,
} from "../types.js";
import {
  deriveContextLabel,
  formatIntegrationReasonForBrief,
  formatRuntimeMs,
  formatTicketTableRow,
  formatWorkerModel,
  formatWorkerTurnSummary,
} from "./run-brief.js";
import { buildCompactWorkflowPanel } from "./workflow-panel.js";

/** Stable identity for the one workflow-summary inspection row. */
export const WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY = "workflow";

/** A stable, presentation-independent dashboard row key. */
export type WorkflowDashboardRowKey = string;

/** The coordinator-derived target represented by a dashboard row. */
export type WorkflowDashboardRowKind =
  | "workflow"
  | "ticket"
  | "worker-attempt"
  | "preflight"
  | "next-action";

/** Dashboard list sections, in their deterministic presentation order. */
export type WorkflowDashboardSectionId =
  | "workflow"
  | "tickets"
  | "workers"
  | "preflight"
  | "next-actions";

/** Detail content for a selected inspection target. */
export type WorkflowDashboardDetail = {
  key: WorkflowDashboardRowKey;
  title: string;
  lines: readonly string[];
};

/** One selectable dashboard row. Its key never depends on rendered text. */
export type WorkflowDashboardRow = {
  key: WorkflowDashboardRowKey;
  kind: WorkflowDashboardRowKind;
  label: string;
  description?: string;
  detail: WorkflowDashboardDetail;
};

/** A labeled group of rows for a persistent dashboard surface. */
export type WorkflowDashboardSection = {
  id: WorkflowDashboardSectionId;
  title: string;
  rows: readonly WorkflowDashboardRow[];
};

/** The selected row and its already-derived detail content. */
export type WorkflowDashboardSelectedTarget = {
  key: WorkflowDashboardRowKey;
  row: WorkflowDashboardRow;
  detail: WorkflowDashboardDetail;
};

/**
 * Pure dashboard input. Every field is a coordinator DTO captured by the
 * caller; this module does not own workflow state or read adapters itself.
 */
export type WorkflowDashboardInputs = {
  panel?: WorkflowPanelState;
  ticketProgress?: TicketProgressSummary;
  preflight: PreflightResult;
  nextActions: readonly NextAction[];
};

/** Presentation state supplied by the persistent dashboard owner. */
export type BuildWorkflowDashboardOptions = {
  /** The previously selected stable row key, if any. */
  selectedKey?: WorkflowDashboardRowKey;
  /** Injectable clock for deterministic last-turn age formatting. */
  nowMs?: number;
};

/** Pure, refresh-safe presentation model for the manual Workflow dashboard. */
export type WorkflowDashboardViewModel = {
  sections: readonly WorkflowDashboardSection[];
  /** Flattened rows in section/presentation order. */
  rows: readonly WorkflowDashboardRow[];
  /** Preserved previous selection, or the first row in deterministic order. */
  selectedKey: WorkflowDashboardRowKey;
  selected: WorkflowDashboardSelectedTarget;
  /** Convenience alias for renderers that only need the detail pane. */
  selectedDetail: WorkflowDashboardDetail;
};

type PanelWorker = WorkflowPanelState["workers"][number];

type DashboardContext = {
  panel: WorkflowPanelState | undefined;
  progress: TicketProgressSummary | undefined;
  ticketItems: readonly TicketProgressItem[];
  nowMs: number;
};

/** Stable key for the workflow summary row. */
export function workflowRowKey(): WorkflowDashboardRowKey {
  return WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY;
}

/** Stable key for one GitHub ticket, independent of its title or status. */
export function ticketRowKey(ticketNumber: number): WorkflowDashboardRowKey {
  return `ticket:${ticketNumber}`;
}

/** Stable key for one Implementation worker attempt. */
export function workerAttemptRowKey(
  ticketNumber: number,
  attempt: number,
): WorkflowDashboardRowKey {
  return `worker:${ticketNumber}:r${attempt}`;
}

/** Stable key for a named coordinator preflight check. */
export function preflightRowKey(
  checkId: PreflightCheckId,
): WorkflowDashboardRowKey {
  return `preflight:${checkId}`;
}

/** Stable key for a Next action, based only on its coordinator action id. */
export function nextActionRowKey(actionId: string): WorkflowDashboardRowKey {
  return `action:${actionId}`;
}

/**
 * Keep a prior selection when its stable key survives a refresh. Otherwise the
 * first row in the fixed section order is the deterministic fallback.
 */
export function resolveWorkflowDashboardSelection(
  previousKey: WorkflowDashboardRowKey | undefined,
  rows: readonly Pick<WorkflowDashboardRow, "key">[],
): WorkflowDashboardRowKey | undefined {
  if (previousKey && rows.some((row) => row.key === previousKey)) {
    return previousKey;
  }
  return rows[0]?.key;
}

/** Short alias for dashboard owners that only need selection reconciliation. */
export const resolveDashboardSelection = resolveWorkflowDashboardSelection;

/**
 * Derive every dashboard row and selected detail pane from coordinator DTOs.
 * This function is deliberately side-effect-free: no coordinator calls,
 * filesystem access, GitHub reads, or mutable selection state are hidden here.
 */
export function buildWorkflowDashboardViewModel(
  inputs: WorkflowDashboardInputs,
  options: BuildWorkflowDashboardOptions = {},
): WorkflowDashboardViewModel {
  const progress = inputs.ticketProgress ?? inputs.panel?.ticketProgress;
  const ticketItems = ticketItemsFor(progress);
  const context: DashboardContext = {
    panel: inputs.panel,
    progress,
    ticketItems,
    nowMs: usableNowMs(options.nowMs),
  };

  const workflowRows = [buildWorkflowRow(inputs, context)];
  const ticketRows = uniqueRows(
    ticketItems.map((item) => buildTicketRow(item, context)),
  );
  const workerRows = uniqueRows(
    sortedWorkers(inputs.panel).map((worker) => buildWorkerRow(worker, context)),
  );
  const preflightRows = uniqueRows(
    sortedPreflightChecks(inputs.preflight).map((check) =>
      buildPreflightRow(check, inputs.preflight),
    ),
  );
  const actionRows = uniqueRows(
    inputs.nextActions.map((action) => buildNextActionRow(action)),
  );

  const sections: WorkflowDashboardSection[] = [
    { id: "workflow", title: "Workflow", rows: workflowRows },
  ];
  if (ticketRows.length > 0) {
    sections.push({ id: "tickets", title: "Tickets", rows: ticketRows });
  }
  if (workerRows.length > 0) {
    sections.push({ id: "workers", title: "Worker attempts", rows: workerRows });
  }
  if (preflightRows.length > 0) {
    sections.push({ id: "preflight", title: "Preflight", rows: preflightRows });
  }
  if (actionRows.length > 0) {
    sections.push({ id: "next-actions", title: "Next actions", rows: actionRows });
  }

  const rows = sections.flatMap((section) => section.rows);
  // The workflow row is unconditional, so the fallback is always available.
  const selectedKey =
    resolveWorkflowDashboardSelection(options.selectedKey, rows) ??
    WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY;
  const selectedRow =
    rows.find((row) => row.key === selectedKey) ?? workflowRows[0]!;

  return {
    sections,
    rows,
    selectedKey: selectedRow.key,
    selected: {
      key: selectedRow.key,
      row: selectedRow,
      detail: selectedRow.detail,
    },
    selectedDetail: selectedRow.detail,
  };
}

function buildWorkflowRow(
  inputs: WorkflowDashboardInputs,
  context: DashboardContext,
): WorkflowDashboardRow {
  const identity = workflowIdentity(context.panel, context.progress);
  const lines: string[] = [];

  if (context.panel) {
    // Preserve the compact-panel formatter for the shared workflow summary.
    lines.push(...buildCompactWorkflowPanel(context.panel).lines);
    const label = deriveContextLabel(context.panel);
    if (label && !lines.includes(label)) {
      lines.push(`Context: ${label}`);
    }
  } else {
    lines.push(
      context.progress
        ? `${identity} (no local panel snapshot)`
        : "No Active workflow.",
    );
  }

  appendTextLine(lines, "Target branch", inputs.preflight.targetBranch);
  lines.push(`Preflight: ${inputs.preflight.ok ? "passed" : "needs attention"}`);
  lines.push(
    inputs.nextActions.length === 0
      ? "Next actions: none available"
      : `Next actions: ${inputs.nextActions.length}`,
  );

  const description = context.panel
    ? deriveContextLabel(context.panel) ?? pipelineSummary(context.panel)
    : context.progress
      ? "No local worker telemetry"
      : "No Active workflow";

  return makeRow({
    key: workflowRowKey(),
    kind: "workflow",
    label: identity,
    description,
    detail: {
      key: workflowRowKey(),
      title: identity,
      lines,
    },
  });
}

function buildTicketRow(
  item: TicketProgressItem,
  context: DashboardContext,
): WorkflowDashboardRow {
  const key = ticketRowKey(item.number);
  const blockers = blockersFor(item, context.progress);
  const lines = ticketDetailLines(item, blockers, context);
  const description = context.panel
    ? formatTicketTableRow(item, context.panel).trim()
    : ticketReadinessLabel(item, blockers);

  return makeRow({
    key,
    kind: "ticket",
    label: `#${item.number} — ${displayTitle(item.title)}`,
    description,
    detail: {
      key,
      title: `Ticket #${item.number}`,
      lines,
    },
  });
}

function buildWorkerRow(
  worker: PanelWorker,
  context: DashboardContext,
): WorkflowDashboardRow {
  const key = workerAttemptRowKey(worker.ticketNumber, worker.attempt);
  const model = formatWorkerModel(worker.workerProfile);
  const description = [
    typeof worker.processAlive === "boolean"
      ? worker.processAlive
        ? "process alive"
        : "process gone"
      : undefined,
    model ? `model ${model}` : undefined,
    nonBlank(worker.progress),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const lines = [
    ...workerOperationalLines(worker, context.nowMs),
    ...ticketContextLines(worker.ticketNumber, context),
    ...integrationContextLines(context.panel, worker.ticketNumber),
    ...ciContextLines(context.panel, worker.ticketNumber),
    ...workflowPrContextLines(context.panel),
  ];

  return makeRow({
    key,
    kind: "worker-attempt",
    label: `#${worker.ticketNumber} r${worker.attempt} — ${worker.status}`,
    description,
    detail: {
      key,
      title: `Worker #${worker.ticketNumber} r${worker.attempt}`,
      lines,
    },
  });
}

function buildPreflightRow(
  check: PreflightResult["checks"][number],
  preflight: PreflightResult,
): WorkflowDashboardRow {
  const key = preflightRowKey(check.id);
  const lines = [
    `Status: ${check.ok ? "passed" : "failed"}`,
    `Guidance: ${check.guidance}`,
  ];
  appendTextLine(lines, "Target branch", preflight.targetBranch);
  const profile = formatWorkerModel(preflight.workerProfile?.profile);
  if (profile) {
    lines.push(`Worker profile: ${profile}`);
  }

  return makeRow({
    key,
    kind: "preflight",
    label: `${check.ok ? "✓" : "✗"} ${check.id}`,
    description: check.guidance,
    detail: {
      key,
      title: `Preflight: ${check.id}`,
      lines,
    },
  });
}

function buildNextActionRow(action: NextAction): WorkflowDashboardRow {
  const key = nextActionRowKey(action.id);
  const label = nonBlank(action.label) ?? "(unnamed Next action)";
  const lines = [`Action id: ${action.id}`];
  const description = nonBlank(action.description);
  if (description) {
    lines.push(`Description: ${description}`);
  }

  return makeRow({
    key,
    kind: "next-action",
    label,
    description,
    detail: {
      key,
      title: `Next action: ${label}`,
      lines,
    },
  });
}

function ticketDetailLines(
  item: TicketProgressItem,
  blockers: readonly number[] | undefined,
  context: DashboardContext,
): string[] {
  const lines = [
    `Title: ${displayTitle(item.title)}`,
    `State: ${item.state}`,
    `Workflow status: ${item.status}`,
    ...ticketReadinessLines(item, blockers),
  ];

  if (context.panel) {
    // Keep the existing run-brief status/runtime overlay authoritative.
    lines.push(`Run brief row: ${formatTicketTableRow(item, context.panel).trim()}`);
  }

  const workers = sortedWorkers(context.panel).filter(
    (worker) => worker.ticketNumber === item.number,
  );
  if (workers.length === 0) {
    lines.push(
      context.panel
        ? "Worker: no active attempt in this panel snapshot"
        : "Worker: no local panel snapshot",
    );
  } else {
    lines.push("Worker attempts:");
    for (const worker of workers) {
      lines.push(
        `  r${worker.attempt}: ${worker.status}`,
        ...workerOperationalLines(worker, context.nowMs).map(
          (line) => `  ${line}`,
        ),
      );
    }
  }

  lines.push(
    ...integrationContextLines(context.panel, item.number),
    ...ciContextLines(context.panel, item.number),
    ...workflowPrContextLines(context.panel),
  );

  return lines;
}

function ticketContextLines(
  ticketNumber: number,
  context: DashboardContext,
): string[] {
  const item = context.ticketItems.find(
    (candidate) => candidate.number === ticketNumber,
  );
  if (!item) {
    return context.progress
      ? [`Ticket: #${ticketNumber} is absent from this ticket-progress snapshot`]
      : [`Ticket: #${ticketNumber} (no ticket-progress snapshot)`];
  }

  const blockers = blockersFor(item, context.progress);
  return [
    `Ticket: #${item.number} — ${displayTitle(item.title)}`,
    `Ticket state: ${item.state}`,
    `Ticket workflow status: ${item.status}`,
    ...ticketReadinessLines(item, blockers),
  ];
}

function workerOperationalLines(
  worker: PanelWorker,
  nowMs: number,
): string[] {
  const lines = [`Status: ${worker.status}`];
  const model = formatWorkerModel(worker.workerProfile);
  if (model) {
    lines.push(`Model: ${model}`);
  }
  appendTextLine(lines, "Worker id", worker.workerId);
  if (typeof worker.pid === "number") {
    lines.push(`PID: ${worker.pid}`);
  }
  if (typeof worker.processAlive === "boolean") {
    lines.push(`Process: ${worker.processAlive ? "alive" : "gone"}`);
  }
  const started = formatKnownTimestamp(worker.startedAtMs);
  if (started) {
    lines.push(`Started: ${started}`);
  }
  const runtime = formatRuntimeMs(worker.runtimeMs);
  if (runtime !== "—") {
    lines.push(`Runtime: ${runtime}`);
  }
  const turnSummary = formatWorkerTurnSummary(worker, nowMs);
  if (turnSummary) {
    lines.push(`Telemetry: ${turnSummary}`);
  }
  appendTextLine(lines, "Progress", worker.progress);
  appendTextLine(lines, "Branch", worker.branchName);
  appendTextLine(lines, "Worktree", worker.worktreePath);
  appendTextLine(lines, "Transcript", worker.transcriptPath);
  return lines;
}

function ticketReadinessLines(
  item: TicketProgressItem,
  blockers: readonly number[] | undefined,
): string[] {
  if (item.status === "ready") {
    return ["Readiness: ready"];
  }
  if (item.status === "blocked") {
    const lines = ["Readiness: blocked"];
    if (blockers && blockers.length > 0) {
      lines.push(`Blockers: ${blockers.map((number) => `#${number}`).join(", ")}`);
    }
    return lines;
  }
  if (item.status === "awaiting-ci") {
    return ["Readiness: awaiting CI"];
  }
  return ["Readiness: closed"];
}

function ticketReadinessLabel(
  item: TicketProgressItem,
  blockers: readonly number[] | undefined,
): string {
  if (item.status === "blocked" && blockers && blockers.length > 0) {
    return `blocked by ${blockers.map((number) => `#${number}`).join(", ")}`;
  }
  return item.status === "awaiting-ci" ? "awaiting CI" : item.status;
}

function integrationContextLines(
  panel: WorkflowPanelState | undefined,
  ticketNumber?: number,
): string[] {
  const integration = panel?.integration;
  if (!integration) return [];
  if (
    typeof ticketNumber === "number" &&
    integration.ticketNumber !== ticketNumber
  ) {
    return [];
  }

  const lines = [
    `Integration: #${integration.ticketNumber} r${integration.attempt} (${integration.status})`,
  ];
  appendTextLine(lines, "Integration branch", integration.branchName);
  const reason = nonBlank(integration.reason);
  if (reason) {
    lines.push(`Integration reason: ${formatIntegrationReasonForBrief(reason)}`);
  }
  return lines;
}

function ciContextLines(
  panel: WorkflowPanelState | undefined,
  ticketNumber?: number,
): string[] {
  const entries = (panel?.ci ?? []).filter(
    (entry) =>
      typeof ticketNumber !== "number" || entry.ticketNumber === ticketNumber,
  );
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`CI: #${entry.ticketNumber} r${entry.attempt} (${entry.status})`);
    appendTextLine(lines, "CI integration branch", entry.integrationBranch);
    appendTextLine(lines, "CI summary", entry.summary);
    appendTextLine(lines, "CI URL", entry.url);
  }
  return lines;
}

function workflowPrContextLines(
  panel: WorkflowPanelState | undefined,
): string[] {
  const workflowPr = panel?.workflowPr;
  if (!workflowPr) return [];
  const lines = [`Workflow PR: #${workflowPr.number} (${workflowPr.status})`];
  lines.push(
    `Workflow PR branches: ${workflowPr.headBranch} → ${workflowPr.baseBranch}`,
  );
  appendTextLine(lines, "Workflow PR URL", workflowPr.url);
  return lines;
}

function ticketItemsFor(
  progress: TicketProgressSummary | undefined,
): TicketProgressItem[] {
  if (!progress) return [];
  if (progress.items.length > 0) {
    return sortedUniqueTicketItems(progress.items);
  }

  // Match the run brief's safe fallback: only synthesize tickets explicitly
  // present in a current bucket; never invent closed or historical rows.
  const items: TicketProgressItem[] = [
    ...progress.ready.map((ticket) => ({
      number: ticket.number,
      title: ticket.title,
      state: "OPEN" as const,
      status: "ready" as const,
    })),
    ...progress.blocked.map((ticket) => ({
      number: ticket.number,
      title: ticket.title,
      state: "OPEN" as const,
      status: "blocked" as const,
      openBlockers: ticket.openBlockers,
    })),
    ...progress.awaitingCi.map((ticket) => ({
      number: ticket.number,
      title: ticket.title,
      state: "OPEN" as const,
      status: "awaiting-ci" as const,
    })),
  ];
  return sortedUniqueTicketItems(items);
}

function sortedUniqueTicketItems(
  items: readonly TicketProgressItem[],
): TicketProgressItem[] {
  const byNumber = new Map<number, TicketProgressItem>();
  for (const item of [...items].sort(
    (left, right) => left.number - right.number,
  )) {
    if (!byNumber.has(item.number)) {
      byNumber.set(item.number, item);
    }
  }
  return [...byNumber.values()];
}

function blockersFor(
  item: TicketProgressItem,
  progress: TicketProgressSummary | undefined,
): readonly number[] | undefined {
  if (item.openBlockers && item.openBlockers.length > 0) {
    return item.openBlockers;
  }
  return progress?.blocked.find((ticket) => ticket.number === item.number)
    ?.openBlockers;
}

function sortedWorkers(
  panel: WorkflowPanelState | undefined,
): PanelWorker[] {
  return [...(panel?.workers ?? [])].sort((left, right) => {
    const byTicket = left.ticketNumber - right.ticketNumber;
    if (byTicket !== 0) return byTicket;
    const byAttempt = left.attempt - right.attempt;
    if (byAttempt !== 0) return byAttempt;
    const leftWorkerId = left.workerId ?? "";
    const rightWorkerId = right.workerId ?? "";
    if (leftWorkerId < rightWorkerId) return -1;
    if (leftWorkerId > rightWorkerId) return 1;
    return 0;
  });
}

function sortedPreflightChecks(
  preflight: PreflightResult,
): PreflightResult["checks"][number][] {
  const order: readonly PreflightCheckId[] = [
    "github-remote",
    "gh-auth",
    "target-branch",
    "matt-skills",
    "worker-profile",
  ];
  return [...preflight.checks].sort(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
}

function uniqueRows(
  rows: readonly WorkflowDashboardRow[],
): WorkflowDashboardRow[] {
  const seen = new Set<WorkflowDashboardRowKey>();
  return rows.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

function makeRow(
  row: Omit<WorkflowDashboardRow, "description"> & {
    description?: string | undefined;
  },
): WorkflowDashboardRow {
  const description = nonBlank(row.description);
  const { description: _description, ...rest } = row;
  return {
    ...rest,
    ...(description ? { description } : {}),
  };
}

function workflowIdentity(
  panel: WorkflowPanelState | undefined,
  progress: TicketProgressSummary | undefined,
): string {
  const workflowId = panel?.workflowId ?? progress?.workflowId;
  if (typeof workflowId !== "number") return "Workflow";
  const title = nonBlank(panel?.title);
  return title ? `Workflow #${workflowId}: ${title}` : `Workflow #${workflowId}`;
}

function pipelineSummary(panel: WorkflowPanelState): string {
  if (panel.runTerminated) return "Pipeline terminated";
  if (panel.pipelinePaused) return "Pipeline paused";
  return "Pipeline running";
}

function displayTitle(title: string): string {
  return nonBlank(title) ?? "(no title)";
}

function appendTextLine(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  const text = nonBlank(value);
  if (text) {
    lines.push(`${label}: ${text}`);
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function usableNowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Date.now();
}

function formatKnownTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
