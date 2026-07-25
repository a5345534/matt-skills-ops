import type {
  AvailableModel,
  NextAction,
  PreflightCheck,
  PreflightResult,
  ResolvedWorkerProfile,
  WorkerProfile,
  WorkflowCoordinator,
  WorkflowRoot,
} from "../types.js";

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
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

const PREFLIGHT_HEADER = "--- Workflow preflight ---";
const NEXT_ACTIONS_HEADER = "--- Next actions ---";
const ROOT_HEADER = "--- Workflow root ---";
const WORKER_HEADER = "--- Worker profile ---";
const REFRESH_ITEM = "Refresh preflight";
const SWITCH_ROOT_ITEM = "Switch Workflow root…";
const CONFIGURE_WORKER_ITEM = "Configure Worker profile…";
const NONE_AVAILABLE = "(none available)";

const SET_GLOBAL_WORKER = "Set global default Worker profile";
const SET_ROOT_WORKER = "Set Workflow-root override";
const CLEAR_ROOT_WORKER = "Clear Workflow-root override";
const BACK_ITEM = "← Back";

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
    WORKER_HEADER,
    formatResolvedProfileLine(preflight.workerProfile),
    PREFLIGHT_HEADER,
    ...preflight.checks.map(formatCheckLine),
    NEXT_ACTIONS_HEADER,
    ...nextLines,
    "---",
    CONFIGURE_WORKER_ITEM,
    REFRESH_ITEM,
  ];

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

    if (selected === CONFIGURE_WORKER_ITEM) {
      await presentWorkerProfileMenu(coordinator, ui);
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
 * Prompt for model (searchable when `ui.input` is available) then thinking level.
 * Model choices come from Pi’s authenticated available catalog.
 */
export async function promptWorkerProfile(
  coordinator: WorkflowCoordinator,
  ui: MattAutoUi,
): Promise<WorkerProfile | undefined> {
  const models = await coordinator.listAvailableModels();
  if (models.length === 0) {
    ui.notify(
      "No authenticated models are available in Pi’s catalog. Authenticate a provider (for example via /login) and retry.",
      "warning",
    );
    return undefined;
  }

  const model = await selectAvailableModel(models, ui);
  if (!model) return undefined;

  const levels = [...model.thinkingLevels];
  if (levels.length === 0) {
    ui.notify(
      `Model ${model.provider}/${model.modelId} reports no supported thinking levels.`,
      "warning",
    );
    return undefined;
  }

  const levelChoice = await ui.select(
    `Thinking level for ${model.provider}/${model.modelId}`,
    levels,
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

/**
 * Searchable model picker: optional filter input, then Pi-style select.
 * Does not change the Workflow home currently selected model.
 */
export async function selectAvailableModel(
  models: readonly AvailableModel[],
  ui: MattAutoUi,
): Promise<AvailableModel | undefined> {
  let filtered: AvailableModel[] = [...models];

  if (ui.input) {
    const query = await ui.input(
      "Filter models (provider, id, or name; empty = all)",
      "search…",
    );
    if (query === undefined) return undefined;
    const needle = query.trim().toLowerCase();
    if (needle.length > 0) {
      filtered = models.filter((model) => {
        const haystack =
          `${model.provider} ${model.modelId} ${model.label}`.toLowerCase();
        return haystack.includes(needle);
      });
    }
  }

  if (filtered.length === 0) {
    ui.notify("No models matched that filter.", "warning");
    return undefined;
  }

  const options = filtered.map((model) => model.label);
  const selected = await ui.select("Select Worker model", options);
  if (!selected) return undefined;

  // Longest match first so provider/id prefixes do not steal longer ids.
  const match = filtered
    .filter((model) =>
      selected.includes(`${model.provider}/${model.modelId}`),
    )
    .sort(
      (a, b) =>
        `${b.provider}/${b.modelId}`.length -
        `${a.provider}/${a.modelId}`.length,
    )[0];
  return match;
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
