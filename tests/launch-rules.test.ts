import { describe, expect, it } from "vitest";
import {
  canLaunchImplementationWorker,
  computeImplementationSlots,
  countRunningImplementationWorkers,
  implementationLaunchBlockReason,
  runningTicketsBlockedByOpen,
} from "../src/launch-rules.js";

describe("countRunningImplementationWorkers", () => {
  it("counts only status === running", () => {
    expect(
      countRunningImplementationWorkers([
        { status: "running" },
        { status: "needs-disposition" },
        { status: "running" },
        { status: "failed" },
      ]),
    ).toBe(2);
    expect(countRunningImplementationWorkers([])).toBe(0);
    expect(
      countRunningImplementationWorkers([{ status: "needs-disposition" }]),
    ).toBe(0);
  });
});

describe("computeImplementationSlots", () => {
  it("is max(0, N - running)", () => {
    expect(computeImplementationSlots(2, 0)).toBe(2);
    expect(computeImplementationSlots(2, 1)).toBe(1);
    expect(computeImplementationSlots(2, 2)).toBe(0);
    expect(computeImplementationSlots(2, 3)).toBe(0);
    expect(computeImplementationSlots(1, 0)).toBe(1);
    expect(computeImplementationSlots(5, 2)).toBe(3);
  });

  it("never returns negative slots", () => {
    expect(computeImplementationSlots(0, 0)).toBe(0);
    expect(computeImplementationSlots(0, 5)).toBe(0);
    expect(computeImplementationSlots(-1, 0)).toBe(0);
  });

  it("floors non-integer inputs safely", () => {
    expect(computeImplementationSlots(2.9, 0.5)).toBe(2);
    expect(computeImplementationSlots(Number.NaN, 1)).toBe(0);
  });
});

describe("implementationLaunchBlockReason / canLaunchImplementationWorker", () => {
  const free = {
    slots: 2,
    pendingDisposition: false,
    pendingIntegration: false,
    activeConflictWorker: false,
    readyCount: 3,
  };

  it("allows launch when slots free, frontier non-empty, and no P1 block", () => {
    expect(implementationLaunchBlockReason(free)).toBeUndefined();
    expect(canLaunchImplementationWorker(free)).toBe(true);
  });

  it("P1: pendingDisposition blocks even when slots remain", () => {
    expect(
      implementationLaunchBlockReason({ ...free, pendingDisposition: true }),
    ).toBe("pending-disposition");
    expect(
      canLaunchImplementationWorker({ ...free, pendingDisposition: true }),
    ).toBe(false);
  });

  it("P1: pendingIntegration blocks new implements", () => {
    expect(
      implementationLaunchBlockReason({ ...free, pendingIntegration: true }),
    ).toBe("pending-integration");
  });

  it("P1: active Conflict worker blocks new implements", () => {
    expect(
      implementationLaunchBlockReason({
        ...free,
        activeConflictWorker: true,
      }),
    ).toBe("conflict-worker");
  });

  it("blocks when slots === 0", () => {
    expect(implementationLaunchBlockReason({ ...free, slots: 0 })).toBe(
      "no-slots",
    );
  });

  it("blocks when ready frontier is empty", () => {
    expect(implementationLaunchBlockReason({ ...free, readyCount: 0 })).toBe(
      "empty-frontier",
    );
  });

  it("prefers disposition over slots / frontier (P1 order)", () => {
    expect(
      implementationLaunchBlockReason({
        slots: 0,
        pendingDisposition: true,
        pendingIntegration: true,
        activeConflictWorker: true,
        readyCount: 0,
      }),
    ).toBe("pending-disposition");
  });
});

describe("runningTicketsBlockedByOpen", () => {
  it("returns running tickets that appear on the blocked frontier", () => {
    expect(
      runningTicketsBlockedByOpen(
        [281, 282, 283],
        [{ number: 282 }, { number: 283 }],
      ),
    ).toEqual([282, 283]);
  });

  it("returns empty when nothing overlaps", () => {
    expect(
      runningTicketsBlockedByOpen([281], [{ number: 282 }]),
    ).toEqual([]);
    expect(runningTicketsBlockedByOpen([], [{ number: 282 }])).toEqual([]);
    expect(runningTicketsBlockedByOpen([281], [])).toEqual([]);
  });

  it("dedupes and sorts", () => {
    expect(
      runningTicketsBlockedByOpen(
        [283, 282, 282],
        [{ number: 283 }, { number: 282 }],
      ),
    ).toEqual([282, 283]);
  });
});
