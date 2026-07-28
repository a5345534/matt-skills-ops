import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  truncateToWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type {
  NextAction,
  PreflightCheckId,
  PreflightResult,
  TicketProgressItem,
  TicketProgressSummary,
  WorkflowCoordinator,
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

/** A coordinator snapshot rendered by the persistent dashboard surface. */
export type WorkflowDashboardSnapshot = WorkflowDashboardInputs;

/**
 * Coordinator reads owned by the dashboard's snapshot boundary. Full reads run
 * only when the surface opens or the operator explicitly refreshes it; polling
 * deliberately uses only `getPanelState({ mode: "local" })`.
 */
export type WorkflowDashboardDataSource = Pick<
  WorkflowCoordinator,
  "preflight" | "nextActions" | "getTicketProgress" | "getPanelState"
>;

/** Minimal TUI handle supplied to a Pi custom component. */
export type WorkflowDashboardTui = {
  requestRender: () => void;
};

/** Theme subset used by the dashboard without coupling callers to Pi's unions. */
export type WorkflowDashboardTheme = {
  // Accept Pi ThemeColor | string without importing ThemeColor here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fg: (color: any, text: string) => string;
  bold: (text: string) => string;
};

/** Lifecycle returned when the operator leaves the passive dashboard. */
export type WorkflowDashboardResult = {
  status: "dismissed";
};

/** Pi custom component shape, kept structural for test and partial-host support. */
export type WorkflowDashboardComponent = {
  render: (width: number) => string[];
  invalidate?: () => void;
  handleInput?: (data: string) => void;
  dispose?: () => void;
};

/** Minimal `ctx.ui.custom()` surface needed by the persistent dashboard. */
export type WorkflowDashboardCustomUi = {
  custom: <T>(
    factory: (
      tui: WorkflowDashboardTui,
      theme: WorkflowDashboardTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => WorkflowDashboardComponent | Promise<WorkflowDashboardComponent>,
    options?: { overlay?: boolean },
  ) => Promise<T | undefined>;
};

/** Presentation-only controls for one dashboard instance. */
export type WorkflowDashboardOptions = {
  /** Avoid a second full coordinator read when a caller already has a snapshot. */
  initialSnapshot?: WorkflowDashboardSnapshot;
  /** Stable row to retain when reopening or recreating the component. */
  selectedKey?: WorkflowDashboardRowKey;
  /** Local worker telemetry polling cadence. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** Number of navigable rows visible before SelectList scrolls. Defaults to 8. */
  maxVisibleRows?: number;
  /** Forwarded to Pi custom UI for callers that explicitly want an overlay. */
  overlay?: boolean;
};

/**
 * Capture a full coordinator snapshot once. This is intentionally separate
 * from local polling so tracker-backed preflight, ticket-progress, and action
 * reads cannot accidentally leak into the interval path.
 */
export async function readWorkflowDashboardSnapshot(
  source: WorkflowDashboardDataSource,
): Promise<WorkflowDashboardSnapshot> {
  const [preflight, nextActions, ticketProgress, panel] = await Promise.all([
    source.preflight(),
    source.nextActions(),
    source.getTicketProgress(),
    source.getPanelState({ mode: "full" }),
  ]);

  return {
    preflight,
    nextActions,
    ...(ticketProgress ? { ticketProgress } : {}),
    ...(panel ? { panel } : {}),
  };
}

/**
 * Open the persistent, passive workflow browser. It owns visual selection and
 * refresh timing only; it never calls `ui.notify()`, mutates coordinator state,
 * or resolves while a user merely inspects a row.
 */
export async function presentWorkflowDashboard(
  source: WorkflowDashboardDataSource,
  ui: WorkflowDashboardCustomUi,
  options: WorkflowDashboardOptions = {},
): Promise<WorkflowDashboardResult> {
  const snapshot =
    options.initialSnapshot ?? (await readWorkflowDashboardSnapshot(source));

  const result = await ui.custom<WorkflowDashboardResult>(
    (tui, theme, _keybindings, done) =>
      createWorkflowDashboardComponent(
        source,
        tui,
        theme,
        done,
        snapshot,
        options,
      ),
    options.overlay ? { overlay: true } : undefined,
  );

  return result ?? { status: "dismissed" };
}

/**
 * Construct the custom component separately so its local polling and keyboard
 * behavior stay testable without opening a real Pi TUI.
 */
export function createWorkflowDashboardComponent(
  source: WorkflowDashboardDataSource,
  tui: WorkflowDashboardTui,
  theme: WorkflowDashboardTheme,
  done: (result: WorkflowDashboardResult) => void,
  initialSnapshot: WorkflowDashboardSnapshot,
  options: WorkflowDashboardOptions = {},
): WorkflowDashboardComponent {
  let snapshot = initialSnapshot;
  let model = buildDashboardModel(snapshot, options.selectedKey);
  let selectedKey: WorkflowDashboardRowKey = model.selectedKey;
  let selectList: SelectList;
  let finished = false;
  let localPollInFlight = false;
  let fullRefreshInFlight = false;
  let refreshStatus = "Live local telemetry";
  let interval: ReturnType<typeof setInterval> | undefined;

  const pollIntervalMs = positiveInteger(options.pollIntervalMs, 500);
  const maxVisibleRows = positiveInteger(options.maxVisibleRows, 8);

  const finish = () => {
    if (finished) return;
    finished = true;
    if (interval) clearInterval(interval);
    done({ status: "dismissed" });
  };

  const selectRow = (key: WorkflowDashboardRowKey) => {
    if (!model.rows.some((row) => row.key === key)) return;
    // This is purely visual state. Do not resolve, notify, or call coordinator.
    selectedKey = key;
    tui.requestRender();
  };

  const rebuild = () => {
    model = buildDashboardModel(snapshot, selectedKey);
    selectedKey = model.selectedKey;
    selectList = makeWorkflowDashboardSelectList(
      model,
      selectedKey,
      theme,
      maxVisibleRows,
      selectRow,
      finish,
    );
  };

  const refreshLocal = async () => {
    if (finished || localPollInFlight || fullRefreshInFlight) return;
    localPollInFlight = true;
    refreshStatus = "Refreshing local telemetry…";
    tui.requestRender();
    try {
      // Keep all tracker-derived snapshot fields intact. Local mode only updates
      // worker/process/progress/turn telemetry and other local panel facts.
      const panel = await source.getPanelState({ mode: "local" });
      if (finished) return;
      snapshot = replaceDashboardPanel(snapshot, panel);
      rebuild();
      refreshStatus = panel
        ? "Live local telemetry"
        : "No local workflow telemetry";
    } catch {
      // Keep the last coherent frame and retry on the next interval; no chat noise.
      refreshStatus = "Local telemetry refresh failed; retrying…";
    } finally {
      localPollInFlight = false;
      if (!finished) tui.requestRender();
    }
  };

  const refreshFull = async () => {
    if (finished || fullRefreshInFlight) return;
    fullRefreshInFlight = true;
    refreshStatus = "Refreshing workflow snapshot…";
    tui.requestRender();
    try {
      snapshot = await readWorkflowDashboardSnapshot(source);
      if (finished) return;
      rebuild();
      refreshStatus = "Workflow snapshot refreshed";
    } catch {
      refreshStatus = "Workflow refresh failed; press r to retry";
    } finally {
      fullRefreshInFlight = false;
      if (!finished) tui.requestRender();
    }
  };

  rebuild();
  interval = setInterval(() => {
    void refreshLocal();
  }, pollIntervalMs);

  return {
    render(width: number): string[] {
      return renderWorkflowDashboard(
        model,
        selectedKey,
        selectList,
        theme,
        refreshStatus,
        width,
      );
    },
    invalidate() {
      // Every styled line is produced during render; invalidating the SelectList
      // and requesting a frame lets a changed theme apply without losing focus.
      selectList.invalidate();
      tui.requestRender();
    },
    handleInput(data: string) {
      if (matchesKey(data, "r") || matchesKey(data, "ctrl+r")) {
        void refreshFull();
        return;
      }
      selectList.handleInput(data);
      if (!finished) tui.requestRender();
    },
    dispose() {
      finished = true;
      if (interval) clearInterval(interval);
    },
  };
}

/** True when a host can present the persistent dashboard. */
export function canPresentWorkflowDashboard(
  ui: { custom?: unknown },
): ui is WorkflowDashboardCustomUi {
  return typeof ui.custom === "function";
}

function buildDashboardModel(
  snapshot: WorkflowDashboardSnapshot,
  selectedKey: WorkflowDashboardRowKey | undefined,
): WorkflowDashboardViewModel {
  return buildWorkflowDashboardViewModel(
    snapshot,
    selectedKey ? { selectedKey } : {},
  );
}

function makeWorkflowDashboardSelectList(
  model: WorkflowDashboardViewModel,
  selectedKey: WorkflowDashboardRowKey,
  theme: WorkflowDashboardTheme,
  maxVisibleRows: number,
  onSelect: (key: WorkflowDashboardRowKey) => void,
  onCancel: () => void,
): SelectList {
  const items = workflowDashboardSelectItems(model);
  const list = new SelectList(
    items,
    maxVisibleRows,
    {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
    {
      // Preserve useful ticket/action identity on normal terminals while the
      // SelectList still contracts safely on narrow widths.
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 64,
    },
  );
  const selectedIndex = items.findIndex((item) => item.value === selectedKey);
  list.setSelectedIndex(selectedIndex);
  // Arrow navigation changes the inline detail immediately and stays in this
  // component. Enter is intentionally another inspection affordance in this
  // browsing slice; dashboard-native action execution is layered separately.
  list.onSelectionChange = (item) => onSelect(item.value);
  list.onSelect = (item) => onSelect(item.value);
  list.onCancel = onCancel;
  return list;
}

function workflowDashboardSelectItems(
  model: WorkflowDashboardViewModel,
): SelectItem[] {
  const sectionTitleByKey = new Map<WorkflowDashboardRowKey, string>();
  for (const section of model.sections) {
    for (const row of section.rows) {
      sectionTitleByKey.set(row.key, section.title);
    }
  }

  return model.rows.map((row) => ({
    value: row.key,
    label: `${sectionTitleByKey.get(row.key) ?? "Workflow"} · ${row.label}`,
    ...(row.description ? { description: row.description } : {}),
  }));
}

function renderWorkflowDashboard(
  model: WorkflowDashboardViewModel,
  selectedKey: WorkflowDashboardRowKey,
  selectList: SelectList,
  theme: WorkflowDashboardTheme,
  refreshStatus: string,
  width: number,
): string[] {
  const renderWidth = usableRenderWidth(width);
  // SelectList expects enough room for its two-column cursor; render it at a
  // safe minimum and clip every final line back to the host-supplied width.
  const componentWidth = Math.max(8, renderWidth);
  const selected =
    model.rows.find((row) => row.key === selectedKey) ?? model.selected.row;
  const workflow =
    model.rows.find((row) => row.key === WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY) ??
    model.selected.row;
  const lines: string[] = [];
  const accentBorder = new DynamicBorder((text) => theme.fg("accent", text));
  const dimBorder = new DynamicBorder((text) => theme.fg("dim", text));

  lines.push(
    dashboardLine(
      theme.fg("accent", theme.bold("Matt Auto · Workflow dashboard")),
      renderWidth,
    ),
  );
  lines.push(...accentBorder.render(componentWidth));
  lines.push(
    dashboardLine(
      theme.fg("accent", theme.bold("Workflow summary")),
      renderWidth,
    ),
  );
  lines.push(
    dashboardLine(
      [workflow.label, workflow.description].filter(Boolean).join(" · "),
      renderWidth,
    ),
  );
  lines.push(...dimBorder.render(componentWidth));
  lines.push(
    dashboardLine(theme.fg("accent", theme.bold("Browse")), renderWidth),
  );
  lines.push(...selectList.render(componentWidth));
  lines.push(...dimBorder.render(componentWidth));
  lines.push(
    dashboardLine(
      theme.fg("accent", theme.bold(`Selected · ${selected.detail.title}`)),
      renderWidth,
    ),
  );
  for (const detailLine of selected.detail.lines) {
    lines.push(dashboardLine(`  ${detailLine}`, renderWidth));
  }
  lines.push(...dimBorder.render(componentWidth));
  lines.push(
    dashboardLine(
      theme.fg(
        "dim",
        `↑↓ browse · Enter inspect · r full refresh · Esc return to chat · ${refreshStatus}`,
      ),
      renderWidth,
    ),
  );
  return lines.map((line) => dashboardLine(line, renderWidth));
}

function replaceDashboardPanel(
  snapshot: WorkflowDashboardSnapshot,
  panel: WorkflowPanelState | undefined,
): WorkflowDashboardSnapshot {
  const { panel: _previousPanel, ...withoutPanel } = snapshot;
  return panel ? { ...withoutPanel, panel } : withoutPanel;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function usableRenderWidth(width: number): number {
  return Number.isFinite(width) && width > 0
    ? Math.max(1, Math.floor(width))
    : 1;
}

function dashboardLine(text: string, width: number): string {
  return truncateToWidth(text.replace(/[\r\n]+/g, " "), width, "…");
}
