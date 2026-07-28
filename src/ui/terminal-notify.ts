/**
 * Terminal completion signals when Matt Auto finishes work outside a normal
 * agent turn (slash-command pipeline). Mirrors npm:@jmcombs/pi-notify OSC paths
 * so Ghostty/iTerm can show a desktop/tab notification ("bell") on complete.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CompletedWorkerTelemetry } from "../types.js";
import { formatRuntimeMs } from "./run-brief.js";
import {
  buildMattAutoActivityTitle,
  setGhosttyProgress,
} from "./ghostty-activity.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

function ttyWrite(seq: string): void {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    try {
      process.stdout.write(seq);
    } catch {
      // non-TTY / tests
    }
  }
}

function wrapForTmux(seq: string): string {
  if (!process.env.TMUX) return seq;
  // DCS passthrough; escape every inner ESC, but leave BEL as a BEL event.
  const escaped = seq.split(ESC).join(`${ESC}${ESC}`);
  return `${ESC}Ptmux;${escaped}${ST}`;
}

function notifyOSC9(message: string): void {
  ttyWrite(wrapForTmux(`${ESC}]9;${message}${BEL}`));
}

function notifyOSC777(title: string, body: string): void {
  ttyWrite(wrapForTmux(`${ESC}]777;notify;${title};${body}${BEL}`));
}

function notifyOSC99(title: string, body: string): void {
  const titleSeq = `${ESC}]99;i=1:d=0;${title}${ST}`;
  const bodySeq = `${ESC}]99;i=1:d=1:p=body;${body}${ST}`;
  ttyWrite(wrapForTmux(titleSeq));
  ttyWrite(wrapForTmux(bodySeq));
}

function isGhostty(): boolean {
  return (process.env.TERM_PROGRAM ?? "").toLowerCase() === "ghostty";
}

/** Send a desktop/tab notification via the terminal's OSC protocol. */
export function sendTerminalNotification(title: string, body: string): void {
  const term = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
    return;
  }
  if (isGhostty() || term === "iterm.app" || process.env.ITERM_SESSION_ID) {
    notifyOSC9(`${title}: ${body}`);
    return;
  }
  // WezTerm, rxvt, Windows Terminal (WSL), etc.
  notifyOSC777(title, body);
}

/** Format retained successful worker facts for a final completion notification. */
export function formatCompletedWorkerTelemetry(
  telemetry: readonly CompletedWorkerTelemetry[],
): readonly string[] {
  return telemetry.map((entry) => {
    const kind = entry.kind === "conflict-resolution" ? " conflict" : "";
    const turns =
      entry.turnCount === 1 ? "1 turn" : `${entry.turnCount} turns`;
    return [
      `#${entry.ticketNumber} r${entry.attempt}${kind}`,
      turns,
      formatRuntimeMs(entry.runtimeMs),
    ].join(" · ");
  });
}

export type CompletionNotifyUi = {
  setTitle?(title: string): void;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
};

/**
 * Signal that a Matt Auto pipeline (or long wait) finished.
 * - Ghostty progress: green 100% then clear (same as pi-ghostty agent_end)
 * - Title: idle/done (no braille spinner)
 * - OSC notify: so unfocused tabs get a "bell" / desktop notification
 */
export function signalMattAutoComplete(
  ui: CompletionNotifyUi,
  options: {
    cwd?: string;
    title?: string;
    body: string;
    /** Retained completed-worker lines shown below the completion body. */
    details?: readonly string[];
    /** When true, use warning styling in TUI notify. */
    warning?: boolean;
  },
): void {
  const title = options.title ?? "Matt Auto";
  const message = [options.body, ...(options.details ?? [])].join("\n");
  setGhosttyProgress(1, 100);
  ui.setTitle?.(
    buildMattAutoActivityTitle({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detail: options.warning ? "done (see notice)" : "done",
    }),
  );
  sendTerminalNotification(title, message);
  if (isGhostty()) {
    // OSC 9's BEL terminator is not a bell event. Ghostty needs a separate
    // BEL to apply bell-features=title (the temporary 🔔 title indicator).
    ttyWrite(wrapForTmux(BEL));
  }
  try {
    ui.notify?.(
      message,
      options.warning ? "warning" : "info",
    );
  } catch {
    // optional
  }
  setTimeout(() => {
    setGhosttyProgress(0);
  }, 800);
}

/** Basename helper for tests / callers. */
export function projectLabel(cwd?: string): string | undefined {
  return cwd ? path.basename(cwd) : undefined;
}
