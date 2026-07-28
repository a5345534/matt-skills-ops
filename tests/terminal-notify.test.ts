import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ writeFileSync: vi.fn() }));

vi.mock("node:fs", () => ({ writeFileSync: mocks.writeFileSync }));

import {
  projectLabel,
  signalMattAutoComplete,
} from "../src/ui/terminal-notify.js";

describe("signalMattAutoComplete", () => {
  it("sets a done title and calls ui.notify", () => {
    const setTitle = vi.fn();
    const notify = vi.fn();
    signalMattAutoComplete(
      { setTitle, notify },
      { cwd: "/tmp/my-project", body: "Workflow #1 complete." },
    );
    expect(setTitle).toHaveBeenCalled();
    const title = setTitle.mock.calls[0]?.[0] as string;
    expect(title).toMatch(/matt-auto/);
    expect(title).toMatch(/done/);
    expect(notify).toHaveBeenCalledWith("Workflow #1 complete.", "info");
  });

  it("includes completed worker telemetry in the final notification", () => {
    const notify = vi.fn();

    signalMattAutoComplete(
      { notify },
      {
        cwd: "/tmp/my-project",
        body: "Workflow #42 complete.",
        details: [
          "#43 r1 · 3 turns · 12s",
          "#44 r1 · 0 turns · 8s",
        ],
      },
    );

    expect(notify).toHaveBeenCalledWith(
      [
        "Workflow #42 complete.",
        "#43 r1 · 3 turns · 12s",
        "#44 r1 · 0 turns · 8s",
      ].join("\n"),
      "info",
    );
  });

  it("emits a standalone BEL after the Ghostty completion notification", () => {
    const originalEnv = {
      termProgram: process.env.TERM_PROGRAM,
      kittyWindowId: process.env.KITTY_WINDOW_ID,
      itermSessionId: process.env.ITERM_SESSION_ID,
      tmux: process.env.TMUX,
    };
    mocks.writeFileSync.mockClear();
    process.env.TERM_PROGRAM = "ghostty";
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.ITERM_SESSION_ID;
    delete process.env.TMUX;

    try {
      signalMattAutoComplete(
        {},
        {
          cwd: "/tmp/my-project",
          body: "Workflow #1 complete.",
          details: ["#43 r1 · 3 turns · 12s"],
        },
      );

      const writes = mocks.writeFileSync.mock.calls
        .filter(([target]) => target === "/dev/tty")
        .map(([, contents]) => String(contents));
      const notification =
        "\x1b]9;Matt Auto: Workflow #1 complete.\n#43 r1 · 3 turns · 12s\x07";

      expect(writes).toContain(notification);
      expect(writes).toContain("\x07");
      expect(writes.indexOf("\x07")).toBeGreaterThan(writes.indexOf(notification));
    } finally {
      restoreEnv("TERM_PROGRAM", originalEnv.termProgram);
      restoreEnv("KITTY_WINDOW_ID", originalEnv.kittyWindowId);
      restoreEnv("ITERM_SESSION_ID", originalEnv.itermSessionId);
      restoreEnv("TMUX", originalEnv.tmux);
    }
  });

  it("passes the standalone Ghostty BEL through tmux unchanged", () => {
    const originalEnv = {
      termProgram: process.env.TERM_PROGRAM,
      kittyWindowId: process.env.KITTY_WINDOW_ID,
      itermSessionId: process.env.ITERM_SESSION_ID,
      tmux: process.env.TMUX,
    };
    mocks.writeFileSync.mockClear();
    process.env.TERM_PROGRAM = "ghostty";
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.ITERM_SESSION_ID;

    try {
      signalMattAutoComplete({}, { body: "Workflow #1 complete." });

      const writes = mocks.writeFileSync.mock.calls
        .filter(([target]) => target === "/dev/tty")
        .map(([, contents]) => String(contents));

      expect(writes).toContain("\x1bPtmux;\x07\x1b\\");
    } finally {
      restoreEnv("TERM_PROGRAM", originalEnv.termProgram);
      restoreEnv("KITTY_WINDOW_ID", originalEnv.kittyWindowId);
      restoreEnv("ITERM_SESSION_ID", originalEnv.itermSessionId);
      restoreEnv("TMUX", originalEnv.tmux);
    }
  });

  it("projectLabel uses basename", () => {
    expect(projectLabel("/a/b/c")).toBe("c");
  });

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});
