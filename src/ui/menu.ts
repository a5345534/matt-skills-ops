import type {
  NextAction,
  PreflightCheck,
  PreflightResult,
  WorkflowCoordinator,
  WorkflowRoot,
} from "../types.js";

/** Minimal UI surface needed by Matt Auto menus. */
export type MattAutoUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

const PREFLIGHT_HEADER = "--- Workflow preflight ---";
const NEXT_ACTIONS_HEADER = "--- Next actions ---";
const ROOT_HEADER = "--- Workflow root ---";
const REFRESH_ITEM = "Refresh preflight";
const SWITCH_ROOT_ITEM = "Switch Workflow root…";
const NONE_AVAILABLE = "(none available)";

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

/** Build bare `/matt-auto` menu lines from coordinator state. */
export function buildMainMenuItems(
  preflight: PreflightResult,
  nextActions: NextAction[],
  currentRoot: WorkflowRoot,
  rootCount: number,
): string[] {
  const nextLines =
    nextActions.length > 0
      ? nextActions.map(formatNextActionLine)
      : [NONE_AVAILABLE];

  const items = [
    ROOT_HEADER,
    formatCurrentRootLine(currentRoot),
    PREFLIGHT_HEADER,
    ...preflight.checks.map(formatCheckLine),
    NEXT_ACTIONS_HEADER,
    ...nextLines,
    "---",
    REFRESH_ITEM,
  ];

  if (rootCount > 1) {
    items.push(SWITCH_ROOT_ITEM);
  }

  return items;
}

/**
 * Present the full Matt Auto menu (root, preflight + Next actions).
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
    const items = buildMainMenuItems(
      preflight,
      nextActions,
      currentRoot,
      roots.length,
    );
    const selected = await ui.select("Matt Auto", items);

    if (selected === undefined) return;
    if (selected === REFRESH_ITEM || selected.startsWith("---")) continue;

    if (selected === SWITCH_ROOT_ITEM) {
      await presentRootSwitcher(coordinator, ui);
      continue;
    }

    if (selected.startsWith("Current:")) {
      await notifyCurrentRoot(currentRoot, ui);
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
      ui.notify(
        `Next action "${action.label}" is not wired yet.`,
        "info",
      );
    }
  }
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
    ui.notify(`Next action "${action.label}" is not wired yet.`, "info");
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

function summarizePreflightFailures(preflight: PreflightResult): string {
  const failed = preflight.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `• ${c.guidance}`);
  return [
    "No Next actions available — Workflow preflight incomplete:",
    ...lines,
  ].join("\n");
}
