import { describe, expect, it } from "vitest";
import { __liveWaitTestables } from "../src/ui/live-run-brief-controls.js";
import type { WorkflowPanelState } from "../src/types.js";

const { isSettled, controlItems } = __liveWaitTestables;

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

  it("offers Pause/Terminate while running and Resume when paused", () => {
    const running = controlItems(panel());
    expect(running.map((i) => i.value)).toEqual(["pause", "terminate"]);
    const paused = controlItems(panel({ pipelinePaused: true }));
    expect(paused.map((i) => i.value)).toEqual(["resume", "terminate"]);
  });
});
