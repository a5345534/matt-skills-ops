/**
 * Live run-brief wait surface via Pi `ctx.ui.custom()`.
 *
 * Unlike blocking `ui.select()` (freezes brief refresh while open), a custom
 * component can:
 *   - poll coordinator panel state on an interval
 *   - re-render the brief with `tui.requestRender()`
 *   - accept ↑↓/Enter selection for Pause / Terminate at the same time
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
import type { WorkflowCoordinator, WorkflowPanelState } from "../types.js";

export type LiveWaitControlChoice =
  | { action: "settled" }
  | { action: "pause" }
  | { action: "terminate" }
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
};

export type LiveWaitTheme = {
  // Accept Pi ThemeColor | string without importing ThemeColor here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fg: (color: any, text: string) => string;
  bold: (text: string) => string;
};

export type LiveWaitPanelSource = Pick<WorkflowCoordinator, "getPanelState">;

function isSettled(panel: WorkflowPanelState | undefined): boolean {
  if (!panel) return true;
  if (panel.runTerminated) return true;
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
      description: "Abort workers; GitHub state unchanged",
    },
    {
      value: "terminate",
      label: "Terminate run…",
      description: "Stop the run and abort session-owned workers",
    },
  ];
}

function makeSelectList(
  panel: WorkflowPanelState,
  theme: LiveWaitTheme,
  onPick: (action: "pause" | "terminate" | "resume") => void,
  onCancel: () => void,
): SelectList {
  const list = new SelectList(controlItems(panel), 4, {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });
  list.onSelect = (item) => {
    onPick(item.value as "pause" | "terminate" | "resume");
  };
  list.onCancel = onCancel;
  return list;
}

/**
 * Live wait: brief auto-refreshes while Pause/Terminate stay selectable.
 * Resolves when workers settle or the operator picks a control.
 */
export async function presentLiveWaitControls(
  ui: LiveWaitCustomUi,
  coordinator: LiveWaitPanelSource,
  initialPanel: WorkflowPanelState,
  options: {
    pollIntervalMs?: number;
    overlay?: boolean;
    /**
     * Called every poll while the live surface is open (e.g. ghostty title
     * braille). Outer wait loops cannot tick during blocking `ui.custom()`.
     */
    onTick?: (panel: WorkflowPanelState) => void;
  } = {},
): Promise<LiveWaitControlChoice> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  const result = await ui.custom<LiveWaitControlChoice>(
    (tui, theme, _kb, done) => {
      let panel = initialPanel;
      let finished = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let wasPaused = panel.pipelinePaused === true;
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
        // Esc is a safe dismissal only after Pause has aborted all workers.
        // The coordinator remains paused; `/matt-auto resume` can restart it.
        if (canDismissPausedLiveWait(panel)) finish({ action: "dismissed" });
      };

      let selectList = makeSelectList(
        panel,
        theme,
        (action) => {
          finish({ action });
        },
        dismissIfPaused,
      );

      const title = new Text(
        theme.fg(
          "accent",
          theme.bold(
            `Matt Auto · Workflow #${panel.workflowId} · live (options + refresh)`,
          ),
        ),
        1,
        0,
      );
      const helpText = (paused: boolean) =>
        paused
          ? "Paused · Esc returns to chat · resume later: /matt-auto resume"
          : "Brief auto-refreshes · ↑↓ / Enter pick control · Esc stays here";
      let help = new Text(
        theme.fg("dim", helpText(panel.pipelinePaused)),
        1,
        0,
      );
      const controlsHeader = new Text(
        theme.fg("accent", theme.bold("Controls")),
        1,
        0,
      );

      const refresh = async () => {
        if (finished) return;
        try {
          const next = await coordinator.getPanelState({ mode: "local" });
          if (!next) {
            finish({ action: "settled" });
            return;
          }
          panel = next;
          briefLines = [
            ...buildRunBriefViewModel(panel, { omitControls: true }).lines,
          ];

          if (panel.runTerminated) {
            finish({ action: "settled" });
            return;
          }
          if (isSettled(panel) && !panel.pipelinePaused) {
            finish({ action: "settled" });
            return;
          }

          const nowPaused = panel.pipelinePaused === true;
          if (nowPaused !== wasPaused) {
            wasPaused = nowPaused;
            selectList = makeSelectList(
              panel,
              theme,
              (action) => {
                finish({ action });
              },
              dismissIfPaused,
            );
            help = new Text(
              theme.fg("dim", helpText(nowPaused)),
              1,
              0,
            );
          }

          // Outer wait loop is blocked on this custom() — drive title/OSC here.
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
              line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line,
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
            finish({ action: "terminate" });
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

  return result ?? { action: "settled" };
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
  canDismissPausedLiveWait,
};
