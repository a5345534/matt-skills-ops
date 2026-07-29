import { describe, expect, it } from "vitest";
import { __liveWaitTestables } from "../src/ui/live-run-brief-controls.js";
import type { WorkflowPanelState } from "../src/types.js";

const { isSettled, controlItems, canDismissPausedLiveWait } =
  __liveWaitTestables;

function panel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 1,
    lines: [],
    workers: [],
    pipelinePaused: false,
    ...overrides,
  };
}

describe("live wait helpers", () => {
  it("isSettled when no runners and not paused", () => {
    expect(isSettled(panel())).toBe(true);
    expect(
      isSettled(
        panel({
          workers: [
            {
              ticketNumber: 1,
              attempt: 1,
              status: "running",
              branchName: "b",
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(isSettled(panel({ pipelinePaused: true }))).toBe(false);
  });

  it("holdUntilRunEnd keeps the surface open across idle ticket gaps", () => {
    // No runners / needs-disposition would settle normally, but not while holding.
    expect(isSettled(panel(), { holdUntilRunEnd: true })).toBe(false);
    expect(
      isSettled(
        panel({
          workers: [
            {
              ticketNumber: 1,
              attempt: 1,
              status: "needs-disposition",
              branchName: "b",
            },
          ],
        }),
        { holdUntilRunEnd: true },
      ),
    ).toBe(false);
    expect(
      isSettled(panel({ runTerminated: true }), { holdUntilRunEnd: true }),
    ).toBe(true);
  });

  it("offers Pause/Terminate while running and Resume when paused", () => {
    const running = controlItems(panel());
    expect(running.map((i) => i.value)).toEqual(["pause", "terminate"]);
    const paused = panel({ pipelinePaused: true });
    expect(controlItems(paused).map((i) => i.value)).toEqual([
      "resume",
      "terminate",
    ]);
    // Esc is an exit only after workers were paused; running live waits stay put.
    expect(canDismissPausedLiveWait(panel())).toBe(false);
    expect(canDismissPausedLiveWait(paused)).toBe(true);
  });
});
