import { describe, expect, it, vi } from "vitest";
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

  it("projectLabel uses basename", () => {
    expect(projectLabel("/a/b/c")).toBe("c");
  });
});
