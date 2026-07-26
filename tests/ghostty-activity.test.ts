import { describe, expect, it } from "vitest";
import {
  BRAILLE_FRAMES,
  buildMattAutoActivityTitle,
  startGhosttyActivity,
} from "../src/ui/ghostty-activity.js";

describe("buildMattAutoActivityTitle", () => {
  it("matches pi-ghostty style segments with optional spinner frame", () => {
    expect(
      buildMattAutoActivityTitle({
        frame: BRAILLE_FRAMES[0],
        cwd: "/home/shawn/projects/active/matt-skills-ops",
        detail: "#17 r1",
      }),
    ).toBe("⠋ π · matt-skills-ops · matt-auto · #17 r1");

    expect(
      buildMattAutoActivityTitle({
        cwd: "/tmp/repo",
      }),
    ).toBe("π · repo · matt-auto");
  });
});

describe("startGhosttyActivity", () => {
  it("ticks braille frames via setTitle and stops cleanly", () => {
    const titles: string[] = [];
    const activity = startGhosttyActivity(
      { setTitle: (t) => titles.push(t) },
      { cwd: "/tmp/demo", detail: "waiting" },
    );

    expect(titles[0]?.startsWith(BRAILLE_FRAMES[0]!)).toBe(true);
    expect(titles[0]).toContain("matt-auto");
    expect(titles[0]).toContain("waiting");

    activity.tick("#21 r1");
    expect(titles.at(-1)).toContain("#21 r1");
    expect(BRAILLE_FRAMES.some((f) => titles.at(-1)?.startsWith(f))).toBe(
      true,
    );

    activity.stop();
    expect(titles.at(-1)).toContain("idle");
    expect(titles.at(-1)?.startsWith("π")).toBe(true);

    const afterStop = titles.length;
    activity.tick("ignored");
    expect(titles.length).toBe(afterStop);
  });
});
