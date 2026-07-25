import type {
  NextAction,
  PreflightCheck,
  PreflightResult,
  WorkflowCoordinator,
} from "../types.js";

/** Minimal UI surface needed by Matt Auto menus. */
export type MattAutoUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

const PREFLIGHT_HEADER = "--- Workflow preflight ---";
const NEXT_ACTIONS_HEADER = "--- Next actions ---";
const REFRESH_ITEM = "Refresh preflight";
const NONE_AVAILABLE = "(none available)";

function formatCheckLine(check: PreflightCheck): string {
  const mark = check.ok ? "✓" : "✗";
  const summary = check.guidance.split(".")[0] ?? check.guidance;
  return `${mark} ${check.id}: ${summary}`;
}

function formatNextActionLine(action: NextAction): string {
  return `${action.label} — ${action.description}`;
}

/** Build bare `/matt-auto` menu lines from coordinator state. */
export function buildMainMenuItems(
  preflight: PreflightResult,
  nextActions: NextAction[],
): string[] {
  const nextLines =
    nextActions.length > 0
      ? nextActions.map(formatNextActionLine)
      : [NONE_AVAILABLE];

  return [
    PREFLIGHT_HEADER,
    ...preflight.checks.map(formatCheckLine),
    NEXT_ACTIONS_HEADER,
    ...nextLines,
    "---",
    REFRESH_ITEM,
  ];
}

/**
 * Present the full Matt Auto menu (preflight + Next actions).
 * Selecting a failed preflight row shows full corrective guidance.
 */
export async function presentMainMenu(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
  for (;;) {
    const preflight = await coordinator.preflight();
    const nextActions = await coordinator.nextActions();
    const items = buildMainMenuItems(preflight, nextActions);
    const selected = await ui.select("Matt Auto", items);

    if (selected === undefined) return;
    if (selected === REFRESH_ITEM || selected.startsWith("---")) continue;
    if (selected === NONE_AVAILABLE) {
      if (!preflight.ok) {
        ui.notify(
          summarizePreflightFailures(preflight),
          "warning",
        );
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

/** Present only currently available Next actions (`/matt-auto next`). */
export async function presentNextActions(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<void> {
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

function summarizePreflightFailures(preflight: PreflightResult): string {
  const failed = preflight.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `• ${c.guidance}`);
  return [
    "No Next actions available — Workflow preflight incomplete:",
    ...lines,
  ].join("\n");
}
