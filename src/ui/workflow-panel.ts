import type { WorkflowPanelState } from "../types.js";
import { deriveContextLabel, formatRuntimeMs } from "./run-brief.js";

function formatCompactRuntime(ms: number): string {
  return formatRuntimeMs(ms);
}

/**
 * Compact secondary Workflow panel view-model.
 * Derived only from `WorkflowPanelState` — the same coordinator DTO as the
 * full-screen run brief. No GitHub reads, no second diagnostic channel.
 * Read-only summary (not a multi-action dashboard).
 */
export type CompactWorkflowPanelViewModel = {
  /** Multi-line widget / menu content. */
  lines: readonly string[];
  /** One-line footer status for `setStatus`. */
  statusLine: string;
  /** Whether the panel has content worth showing. */
  visible: boolean;
};

/** Pi TUI widget key for the always-on Workflow panel. */
export const WORKFLOW_PANEL_WIDGET_KEY = "matt-auto-workflow-panel";

/** Pi TUI footer status key for the compact Workflow panel. */
export const WORKFLOW_PANEL_STATUS_KEY = "matt-auto";

type PanelWorker = WorkflowPanelState["workers"][number];

/**
 * Optional Pi TUI surface for the secondary Workflow panel.
 * When `setWidget` / `setStatus` are absent, publish is a graceful no-op —
 * the full-screen run brief remains the primary operator surface.
 */
export type WorkflowPanelSurface = {
  setWidget?: (
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
  setStatus?: (key: string, text: string | undefined) => void;
};

/**
 * Map `getPanelState()` DTO → condensed Workflow panel lines + footer status.
 * Includes workflow id, pause/terminate, worker ticket/status/alive, and
 * optional one-line progress. Missing optional fields are omitted.
 */
export function buildCompactWorkflowPanel(
  panel: WorkflowPanelState,
): CompactWorkflowPanelViewModel {
  const lines: string[] = [];
  const pipelineStatus = pipelineStatusLabel(panel);

  const title = panel.title?.trim();
  const identity = title
    ? `Workflow #${panel.workflowId}: ${title}`
    : `Workflow #${panel.workflowId}`;
  lines.push(pipelineStatus ? `${identity} · ${pipelineStatus}` : identity);

  const context = deriveContextLabel(panel);
  if (context && context !== "Pipeline paused" && context !== "Run terminated") {
    // Paused/terminated already appear on the identity line.
    lines.push(context);
  }

  for (const worker of panel.workers) {
    lines.push(formatCompactWorkerLine(worker));
  }

  if (panel.integration && panel.workers.length === 0) {
    const reason = panel.integration.reason
      ? ` — ${panel.integration.reason}`
      : "";
    lines.push(
      `Integration #${panel.integration.ticketNumber} r${panel.integration.attempt}: ${panel.integration.status}${reason}`,
    );
  }

  if (panel.ci && panel.ci.length > 0 && panel.workers.length === 0) {
    for (const entry of panel.ci) {
      const detail = entry.summary ? ` — ${entry.summary}` : "";
      lines.push(
        `CI #${entry.ticketNumber} r${entry.attempt}: ${entry.status}${detail}`,
      );
    }
  }

  if (panel.workflowPr && panel.workers.length === 0) {
    lines.push(
      `Workflow PR #${panel.workflowPr.number}: ${panel.workflowPr.status}`,
    );
  }

  // Compact issue table (same columns as full brief, narrower title via shared formatter).
  if (panel.ticketProgress) {
    const progress = panel.ticketProgress;
    const items =
      progress.items && progress.items.length > 0
        ? [...progress.items].sort((a, b) => a.number - b.number)
        : [];
    if (items.length > 0) {
      lines.push(
        `Tickets ${progress.ready.length}r/${progress.open}o/${progress.closed}c`,
      );
      // Import-free compact rows: # STATUS RUNTIME READY title
      for (const item of items) {
        const worker = panel.workers.find(
          (w) => w.ticketNumber === item.number,
        );
        const ready =
          item.status === "blocked"
            ? item.openBlockers?.length
              ? `blk #${item.openBlockers.join(",")}`
              : "blocked"
            : item.status === "ready" || item.status === "awaiting-ci"
              ? "ready"
              : "—";
        let status: string = item.status;
        if (item.status === "closed") status = "closed";
        else if (worker) {
          status =
            worker.status === "needs-disposition"
              ? `needs-d r${worker.attempt}`
              : `${worker.status} r${worker.attempt}`;
        }
        const runtime =
          typeof worker?.runtimeMs === "number"
            ? formatCompactRuntime(worker.runtimeMs)
            : "—";
        const title =
          item.title.length > 28
            ? `${item.title.slice(0, 27)}…`
            : item.title;
        lines.push(
          `  ${("" + item.number).padStart(3)} ${ready.padEnd(10)} ${runtime.padEnd(7)} ${status.padEnd(14)} ${title}`,
        );
      }
    }
  }

  const statusLine = buildStatusLine(panel, pipelineStatus, context);
  const visible =
    panel.workers.length > 0 ||
    panel.pipelinePaused ||
    Boolean(panel.runTerminated) ||
    Boolean(panel.integration) ||
    Boolean(panel.ci && panel.ci.length > 0) ||
    Boolean(panel.workflowPr) ||
    Boolean(panel.ticketProgress && panel.ticketProgress.total > 0);

  return { lines, statusLine, visible };
}

/**
 * Compact passive Workflow panel lines for menus / widgets.
 * Same derivation path as the secondary TUI surface (not `panel.lines`).
 */
export function formatCompactWorkflowPanelLines(
  panel: WorkflowPanelState,
): string[] {
  return [...buildCompactWorkflowPanel(panel).lines];
}

/**
 * Push compact Workflow panel content to the Pi TUI when widget/status APIs exist.
 * Missing APIs (or host throws) are a graceful no-op so `/matt-auto run` still works;
 * the full-screen run brief remains primary.
 */
export type PublishWorkflowPanelOptions = {
  /**
   * `full` — widget lines + footer status (default).
   * `status-only` — footer status only; clear the multi-line widget so it does
   * not duplicate the full-screen run brief ticket table during auto-wait.
   */
  mode?: "full" | "status-only";
};

export function publishWorkflowPanel(
  ui: WorkflowPanelSurface,
  panel: WorkflowPanelState | undefined,
  options: PublishWorkflowPanelOptions = {},
): CompactWorkflowPanelViewModel | undefined {
  const mode = options.mode ?? "full";
  const vm = panel ? buildCompactWorkflowPanel(panel) : undefined;
  const show = Boolean(vm?.visible);

  const hasWidget = typeof ui.setWidget === "function";
  const hasStatus = typeof ui.setStatus === "function";
  if (!hasWidget && !hasStatus) {
    return vm;
  }

  try {
    if (show && vm) {
      if (hasWidget) {
        if (mode === "status-only") {
          ui.setWidget!(WORKFLOW_PANEL_WIDGET_KEY, undefined);
        } else {
          ui.setWidget!(WORKFLOW_PANEL_WIDGET_KEY, [...vm.lines]);
        }
      }
      if (hasStatus) {
        ui.setStatus!(WORKFLOW_PANEL_STATUS_KEY, vm.statusLine);
      }
    } else {
      if (hasWidget) {
        ui.setWidget!(WORKFLOW_PANEL_WIDGET_KEY, undefined);
      }
      if (hasStatus) {
        ui.setStatus!(WORKFLOW_PANEL_STATUS_KEY, undefined);
      }
    }
  } catch {
    // Non-TUI or partial hosts must never break the pipeline wait loop.
  }

  return vm;
}

/** Clear the secondary Workflow panel from the TUI when present. */
export function clearWorkflowPanel(ui: WorkflowPanelSurface): void {
  publishWorkflowPanel(ui, undefined);
}

function pipelineStatusLabel(
  panel: WorkflowPanelState,
): string | undefined {
  if (panel.runTerminated) return "terminated";
  if (panel.pipelinePaused) return "paused";
  return undefined;
}

function formatCompactWorkerLine(worker: PanelWorker): string {
  let line = `#${worker.ticketNumber} r${worker.attempt}: ${worker.status}`;
  if (typeof worker.processAlive === "boolean") {
    line += worker.processAlive ? " · alive" : " · process gone";
  }
  if (worker.progress?.trim()) {
    line += ` — ${worker.progress.trim()}`;
  }
  return line;
}

function buildStatusLine(
  panel: WorkflowPanelState,
  pipelineStatus: string | undefined,
  context: string | undefined,
): string {
  const parts = [`Workflow #${panel.workflowId}`];
  if (pipelineStatus) {
    parts.push(pipelineStatus);
  }
  if (context) {
    parts.push(context);
  } else {
    const first = panel.workers[0];
    if (first) {
      let workerBit = `#${first.ticketNumber} r${first.attempt} ${first.status}`;
      if (typeof first.processAlive === "boolean") {
        workerBit += first.processAlive ? " alive" : " process gone";
      }
      parts.push(workerBit);
    }
  }
  return parts.join(" · ");
}
