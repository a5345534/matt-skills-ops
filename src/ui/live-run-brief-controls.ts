/**
 * Live run-brief wait surface via Pi `ctx.ui.custom()`.
 *
 * Unlike blocking `ui.select()` (freezes brief refresh while open), a custom
 * component can:
 *   - poll coordinator panel state on an interval
 *   - re-render the brief with `tui.requestRender()`
 *   - accept ↑↓/Enter selection for Pause / Terminate at the same time
 *
 * Pause / Resume / Terminate confirmation stays **inside** this surface so the
 * brief never goes blank between "Pause…" and the post-confirm Resume UI
 * (closing custom for a separate ui.select left operators with no responsive
 * controls when pausePipeline or re-open hung).
 *
 * Pi docs: extensions.md Custom Components; tui.md SelectList pattern;
 * examples/extensions/overlay-qa-tests.ts AnimationDemo (setInterval + render).
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { buildRunBriefViewModel } from "./run-brief.js";
import { publishWorkflowPanel } from "./workflow-panel.js";
import type { WorkflowCoordinator, WorkflowPanelState } from "../types.js";

export type LiveWaitControlChoice =
  | { action: "settled" }
  /** Operator confirmed Pause inside the live surface (outer applies pause). */
  | { action: "pause" }
  /** Operator confirmed Terminate inside the live surface. */
  | { action: "terminate" }
  /** Operator confirmed Resume inside the live surface. */
  | { action: "resume" }
  /** Esc on a paused surface: return to chat while preserving pause state. */
  | { action: "dismissed" };

/** Minimal custom-UI surface from Pi extension context. */
export type LiveWaitCustomUi = {
  custom: <T>(
    factory: (
      tui: { requestRender: () => void },
      theme: LiveWaitTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => {
      render: (width: number) => string[];
      invalidate?: () => void;
      handleInput?: (data: string) => void;
      dispose?: () => void;
    },
    options?: { overlay?: boolean },
  ) => Promise<T | undefined>;
  /** Optional Pi TUI footer status (kept in sync with live brief polls). */
  setStatus?(key: string, value: string | undefined): void;
  setWidget?(key: string, lines: string[] | undefined): void;
};

export type LiveWaitTheme = {
  bold: (s: string) => string;
  fg: (color: string, s: string) => string;
};

export type LiveWaitPanelSource = Pick<WorkflowCoordinator, "getPanelState">;

type ConfirmKind = "pause" | "resume" | "terminate";

function isSettled(
  panel: WorkflowPanelState | undefined,
  options: { holdUntilRunEnd?: boolean } = {},
): boolean {
  if (!panel) return true;
  if (panel.runTerminated) return true;
  if (options.holdUntilRunEnd) {
    // Stay open across ticket gaps, disposition, and Integration until the run ends.
    return false;
  }
  if (panel.pipelinePaused) return false;
  if (panel.workers.some((w) => w.status === "running")) return false;
  if (panel.integration?.status === "conflict-resolution") return false;
  if (panel.integration?.status === "running") return false;
  return true;
}

function canDismissPausedLiveWait(panel: WorkflowPanelState): boolean {
  return panel.pipelinePaused === true;
}

function controlItems(panel: WorkflowPanelState): SelectItem[] {
  if (panel.pipelinePaused) {
    return [
      {
        value: "resume",
        label: "Resume pipeline…",
        description: "Continue auto-advance (reuses unintegrated attempts)",
      },
      {
        value: "terminate",
        label: "Terminate run…",
        description: "Stop the run and abort session-owned workers",
      },
    ];
  }
  return [
    {
      value: "pause",
      label: "Pause pipeline…",
      description: "Abort workers; tracker state unchanged",
    },
    {
      value: "terminate",
      label: "Terminate run…",
      description: "Stop the run and abort session-owned workers",
    },
  ];
}

function confirmItems(kind: ConfirmKind, workflowId: number): SelectItem[] {
  if (kind === "pause") {
    return [
      {
        value: "confirm",
        label: "Confirm Pause",
        description: `Abort workers for Workflow #${workflowId}; tracker unchanged`,
      },
      {
        value: "cancel",
        label: "Cancel",
        description: "Back to live controls — pipeline keeps running",
      },
    ];
  }
  if (kind === "resume") {
    return [
      {
        value: "confirm",
        label: "Confirm Resume",
        description: `Continue auto-advance for Workflow #${workflowId}`,
      },
      {
        value: "cancel",
        label: "Cancel",
        description: "Stay paused",
      },
    ];
  }
  return [
    {
      value: "confirm",
      label: "Confirm Terminate",
      description: `Stop the run for Workflow #${workflowId}`,
    },
    {
      value: "cancel",
      label: "Cancel",
      description: "Back to live controls",
    },
  ];
}

function makeSelectList(
  items: SelectItem[],
  theme: LiveWaitTheme,
  onPick: (value: string) => void,
  onCancel: () => void,
): SelectList {
  const list = new SelectList(items, 6, {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });
  list.onSelect = (item) => {
    onPick(item.value);
  };
  list.onCancel = onCancel;
  return list;
}

/**
 * Live wait: brief auto-refreshes while Pause/Terminate stay selectable.
 * Resolves when workers settle or the operator confirms a control.
 */
export async function presentLiveWaitControls(
  ui: LiveWaitCustomUi,
  coordinator: LiveWaitPanelSource,
  initialPanel: WorkflowPanelState,
  options: {
    pollIntervalMs?: number;
    overlay?: boolean;
    /**
     * Keep the surface open across ticket transitions / disposition / Integration
     * until the run ends (runTerminated) or shouldFinish() is true.
     */
    holdUntilRunEnd?: boolean;
    /** When holdUntilRunEnd, finish as soon as this returns true (pipeline done). */
    shouldFinish?: () => boolean;
    /**
     * Called every poll while the live surface is open (e.g. ghostty title
     * braille). Outer wait loops cannot tick during blocking `ui.custom()`.
     */
    onTick?: (panel: WorkflowPanelState) => void;
  } = {},
): Promise<LiveWaitControlChoice> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const holdUntilRunEnd = options.holdUntilRunEnd === true;

  const result = await ui.custom<LiveWaitControlChoice>(
    (tui, theme, _kb, done) => {
      let panel = initialPanel;
      let finished = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let wasPaused = panel.pipelinePaused === true;
      /** When set, Controls shows in-surface Confirm / Cancel for that action. */
      let confirmKind: ConfirmKind | undefined;
      // omitControls: live surface already owns Pause/Terminate SelectList.
      let briefLines = [
        ...buildRunBriefViewModel(panel, { omitControls: true }).lines,
      ];

      const finish = (choice: LiveWaitControlChoice) => {
        if (finished) return;
        finished = true;
        if (interval) clearInterval(interval);
        done(choice);
      };

      const dismissIfPaused = () => {
        // Esc during confirm cancels the confirm, not the whole surface.
        if (confirmKind) {
          confirmKind = undefined;
          rebuildSelectList();
          tui.requestRender();
          return;
        }
        // Esc is a safe dismissal only after Pause has aborted all workers.
        if (canDismissPausedLiveWait(panel)) finish({ action: "dismissed" });
      };

      const onControlPick = (value: string) => {
        if (confirmKind) {
          if (value === "confirm") {
            finish({ action: confirmKind });
            return;
          }
          // cancel
          confirmKind = undefined;
          rebuildSelectList();
          tui.requestRender();
          return;
        }
        if (value === "pause" || value === "resume" || value === "terminate") {
          confirmKind = value;
          rebuildSelectList();
          tui.requestRender();
        }
      };

      function rebuildSelectList() {
        const items = confirmKind
          ? confirmItems(confirmKind, panel.workflowId)
          : controlItems(panel);
        selectList = makeSelectList(items, theme, onControlPick, dismissIfPaused);
        help = new Text(
          theme.fg(
            "dim",
            confirmKind
              ? `Confirm ${confirmKind} for Workflow #${panel.workflowId} · Esc cancels`
              : helpText(panel.pipelinePaused === true),
          ),
          1,
          0,
        );
        controlsHeader = new Text(
          theme.fg(
            "accent",
            theme.bold(
              confirmKind
                ? `Confirm ${confirmKind.charAt(0).toUpperCase()}${confirmKind.slice(1)}`
                : "Controls",
            ),
          ),
          1,
          0,
        );
      }

      let selectList: SelectList;
      let help: Text;
      let controlsHeader: Text;

      const title = new Text(
        theme.fg(
          "accent",
          theme.bold(
            holdUntilRunEnd
              ? `Matt Auto · Workflow #${panel.workflowId} · live until run ends`
              : `Matt Auto · Workflow #${panel.workflowId} · live (options + refresh)`,
          ),
        ),
        1,
        0,
      );
      const helpText = (paused: boolean) =>
        paused
          ? "Paused · Esc returns to chat · resume later: /matt-auto resume"
          : holdUntilRunEnd
            ? "Brief stays up for the whole run · 0.5s refresh · ↑↓ / Enter controls"
            : "Brief auto-refreshes · ↑↓ / Enter pick control · Esc stays here";

      // Initialize select list after helpers exist.
      selectList = makeSelectList(
        controlItems(panel),
        theme,
        onControlPick,
        dismissIfPaused,
      );
      help = new Text(
        theme.fg("dim", helpText(panel.pipelinePaused)),
        1,
        0,
      );
      controlsHeader = new Text(
        theme.fg("accent", theme.bold("Controls")),
        1,
        0,
      );

      const refresh = async () => {
        if (finished) return;
        try {
          if (options.shouldFinish?.()) {
            finish({ action: "settled" });
            return;
          }
          const next = await coordinator.getPanelState({ mode: "local" });
          if (!next) {
            finish({ action: "settled" });
            return;
          }
          panel = next;
          briefLines = [
            ...buildRunBriefViewModel(panel, { omitControls: true }).lines,
          ];
          try {
            publishWorkflowPanel(ui, panel, { mode: "status-only" });
          } catch {
            // Optional TUI status APIs — never break the wait surface.
          }

          if (panel.runTerminated) {
            finish({ action: "settled" });
            return;
          }
          if (
            isSettled(panel, { holdUntilRunEnd }) &&
            !panel.pipelinePaused
          ) {
            finish({ action: "settled" });
            return;
          }

          const nowPaused = panel.pipelinePaused === true;
          // Rebuild primary controls when pause state flips, but never while the
          // operator is mid-confirm (would wipe Confirm Pause under them).
          if (nowPaused !== wasPaused && !confirmKind) {
            wasPaused = nowPaused;
            rebuildSelectList();
          } else if (nowPaused !== wasPaused) {
            wasPaused = nowPaused;
          }

          try {
            options.onTick?.(panel);
          } catch {
            // Activity indicators must never break the wait surface.
          }

          tui.requestRender();
        } catch {
          // Keep last frame; next tick retries.
        }
      };

      interval = setInterval(() => {
        void refresh();
      }, pollIntervalMs);
      void refresh();

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          lines.push(...title.render(width));
          lines.push(
            ...new DynamicBorder((s) => theme.fg("accent", s)).render(width),
          );
          for (const line of briefLines) {
            lines.push(
              line.length > width
                ? `${line.slice(0, Math.max(0, width - 1))}…`
                : line,
            );
          }
          lines.push(
            ...new DynamicBorder((s) => theme.fg("dim", s)).render(width),
          );
          lines.push(...controlsHeader.render(width));
          lines.push(...selectList.render(width));
          lines.push(...help.render(width));
          return lines;
        },
        invalidate() {
          title.invalidate();
          selectList.invalidate();
          help.invalidate();
          controlsHeader.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, "ctrl+c")) {
            // Emergency path: still require in-surface terminate confirm.
            confirmKind = "terminate";
            rebuildSelectList();
            tui.requestRender();
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
        dispose() {
          if (interval) clearInterval(interval);
        },
      };
    },
    options.overlay ? { overlay: true } : undefined,
  );

  // Pi RPC / partial hosts resolve custom() as undefined without running the factory.
  // Do not pretend workers settled — callers must fall back to select/chat brief.
  if (result === undefined) {
    throw new Error(
      "Live wait custom surface returned undefined (UI host may not support ctx.ui.custom).",
    );
  }
  return result;
}

/** True when the UI can host a live custom wait surface. */
export function canPresentLiveWaitControls(
  ui: { custom?: unknown },
): ui is LiveWaitCustomUi {
  return typeof ui.custom === "function";
}

export const __liveWaitTestables = {
  isSettled,
  controlItems,
  confirmItems,
  canDismissPausedLiveWait,
};
