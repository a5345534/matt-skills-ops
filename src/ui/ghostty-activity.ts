/**
 * Terminal activity indicators aligned with npm:pi-ghostty protocol:
 * - Braille spinner frames in the window/tab title (via setTitle)
 * - Ghostty OSC 9;4 progress bar on /dev/tty (indeterminate while busy)
 *
 * Used when Workflow home's agent is idle but Matt Auto workers are still
 * running — pi-ghostty only spins on agent_start/agent_end of the home agent.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

/** Same frame set as pi-ghostty. */
export const BRAILLE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export type ActivityTitleApi = {
  setTitle?(title: string): void;
};

export type GhosttyActivityHandle = {
  /** Advance spinner frame and refresh title (call on wait ticks). */
  tick(detail?: string): void;
  /** Stop spinner; green 100% flash then clear progress (pi-ghostty pattern). */
  stop(): void;
};

function ghosttyWrite(seq: string): void {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    // /dev/tty unavailable (tests, non-TTY, subagent)
  }
}

/** Ghostty OSC 9;4 — same as pi-ghostty setProgress. */
export function setGhosttyProgress(state: number, value?: number): void {
  const args = value !== undefined ? `${state};${value}` : `${state}`;
  ghosttyWrite(`\x1b]9;4;${args}\x07`);
}

/**
 * Build a title segment list like pi-ghostty: π · project · matt-auto · detail
 */
export function buildMattAutoActivityTitle(input: {
  frame?: string;
  cwd?: string;
  detail?: string;
}): string {
  const segments: string[] = ["π"];
  const base = input.cwd ? path.basename(input.cwd) : undefined;
  if (base) segments.push(base);
  segments.push("matt-auto");
  if (input.detail?.trim()) segments.push(input.detail.trim());
  const body = segments.join(" · ");
  return input.frame ? `${input.frame} ${body}` : body;
}

/**
 * Start busy activity for a Matt Auto wait/run segment.
 * No-ops title updates when setTitle is missing; still tries OSC progress.
 */
export function startGhosttyActivity(
  ui: ActivityTitleApi,
  options: { cwd?: string; detail?: string } = {},
): GhosttyActivityHandle {
  let frameIndex = 0;
  let detail = options.detail;
  let stopped = false;

  setGhosttyProgress(3); // indeterminate pulse (pi-ghostty agent_start)

  const paint = () => {
    if (stopped) return;
    const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]!;
    frameIndex += 1;
    const title = buildMattAutoActivityTitle({
      frame,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(detail ? { detail } : {}),
    });
    ui.setTitle?.(title);
  };

  paint();

  return {
    tick(nextDetail?: string) {
      if (stopped) return;
      if (nextDetail !== undefined) detail = nextDetail;
      paint();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      setGhosttyProgress(1, 100);
      ui.setTitle?.(
        buildMattAutoActivityTitle({
          ...(options.cwd ? { cwd: options.cwd } : {}),
          detail: "idle",
        }),
      );
      // Match pi-ghostty: clear progress bar after a short completion flash.
      setTimeout(() => {
        setGhosttyProgress(0);
      }, 800);
    },
  };
}
