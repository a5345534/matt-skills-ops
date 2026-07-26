import { describe, expect, it, vi } from "vitest";
import {
  waitForPipelineWorkers,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type { WorkflowPanelState } from "../src/types.js";

function basePanel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 42,
    title: "Ship run brief wait",
    lines: ["Workflow #42"],
    workers: [],
    pipelinePaused: false,
    ...overrides,
  };
}

function runningWorker(
  overrides: Partial<WorkflowPanelState["workers"][number]> = {},
): WorkflowPanelState["workers"][number] {
  return {
    ticketNumber: 19,
    attempt: 1,
    status: "running",
    workerId: "implement-42-19-r1",
    pid: 9001,
    processAlive: true,
    branchName: "matt-auto/42/ticket-19/r1",
    worktreePath: "/workspaces/42/ticket-19/r1",
    transcriptPath: "/transcripts/42/ticket-19/r1.jsonl",
    progress: "Implementing wait brief",
    ...overrides,
  };
}

function mockUi(): MattAutoUi & { notices: string[] } {
  const notices: string[] = [];
  return {
    notices,
    select: async () => undefined,
    notify: (message) => {
      notices.push(message);
    },
  };
}

describe("waitForPipelineWorkers", () => {
  it("shows multi-section run brief with worker inspection fields while running", async () => {
    const panels: WorkflowPanelState[] = [
      basePanel({ workers: [runningWorker()] }),
      basePanel({
        workers: [
          runningWorker({
            progress: "Still working",
            processAlive: true,
          }),
        ],
      }),
      basePanel({
        workers: [
          {
            ticketNumber: 19,
            attempt: 1,
            status: "needs-disposition",
            workerId: "implement-42-19-r1",
            branchName: "matt-auto/42/ticket-19/r1",
            worktreePath: "/workspaces/42/ticket-19/r1",
            transcriptPath: "/transcripts/42/ticket-19/r1.jsonl",
          },
        ],
      }),
    ];
    let call = 0;
    const coordinator = {
      getPanelState: async () => panels[Math.min(call++, panels.length - 1)]!,
    };
    const ui = mockUi();
    const sleep = vi.fn(async () => undefined);

    await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 10,
      sleep,
    });

    expect(sleep).toHaveBeenCalled();
    // At least one refresh while running + final settle brief.
    expect(ui.notices.length).toBeGreaterThanOrEqual(2);

    const joined = ui.notices.join("\n---\n");
    expect(joined).toContain("Workflow");
    expect(joined).toContain("Workflow #42: Ship run brief wait");
    expect(joined).toContain("Pipeline");
    expect(joined).toContain("Status: running");
    expect(joined).toContain("Workers");
    expect(joined).toContain("#19 r1: running");
    expect(joined).toContain("workerId: implement-42-19-r1");
    expect(joined).toContain("pid: 9001");
    expect(joined).toContain("processAlive: true");
    expect(joined).toContain("branch: matt-auto/42/ticket-19/r1");
    expect(joined).toContain("worktree: /workspaces/42/ticket-19/r1");
    expect(joined).toContain("transcript: /transcripts/42/ticket-19/r1.jsonl");
    expect(joined).toContain("progress: Implementing wait brief");
    // Final settle surface shows needs-disposition (Auto-Close path).
    expect(joined).toContain("#19 r1: needs-disposition");
    // Not a general Next-action dashboard.
    expect(joined).not.toMatch(/Next actions|implement-ticket:|\[x\]|click/i);
  });

  it("settles immediately when only needs-disposition workers remain", async () => {
    const coordinator = {
      getPanelState: async () =>
        basePanel({
          workers: [
            {
              ticketNumber: 19,
              attempt: 1,
              status: "needs-disposition",
              branchName: "matt-auto/42/ticket-19/r1",
            },
          ],
        }),
    };
    const ui = mockUi();
    const sleep = vi.fn(async () => undefined);

    await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 5,
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(ui.notices.length).toBe(1);
    expect(ui.notices[0]).toContain("#19 r1: needs-disposition");
    expect(ui.notices[0]).toContain("Needs disposition #19 r1");
  });

  it("settles on empty running set without blocking", async () => {
    const coordinator = {
      getPanelState: async () => basePanel({ workers: [] }),
    };
    const ui = mockUi();
    const sleep = vi.fn(async () => undefined);

    await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 5,
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps process-gone state visible on the brief via panel reconciliation", async () => {
    const panels: WorkflowPanelState[] = [
      basePanel({
        workers: [runningWorker({ processAlive: true })],
      }),
      basePanel({
        workers: [
          runningWorker({
            processAlive: false,
            progress: "process gone — reconciling",
          }),
        ],
      }),
      basePanel({ workers: [] }),
    ];
    let call = 0;
    const coordinator = {
      getPanelState: async () => panels[Math.min(call++, panels.length - 1)]!,
    };
    const ui = mockUi();

    await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 10,
      sleep: async () => undefined,
    });

    const joined = ui.notices.join("\n");
    expect(joined).toContain("processAlive: false");
    expect(joined).toContain("process gone — reconciling");
  });

  it("times out with a warning after maxTicks while workers stay running", async () => {
    const coordinator = {
      getPanelState: async () =>
        basePanel({ workers: [runningWorker()] }),
    };
    const ui = mockUi();
    let sleeps = 0;

    await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 3,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(sleeps).toBe(3);
    expect(ui.notices.at(-1)).toMatch(/Timed out waiting for workers/i);
  });
});
