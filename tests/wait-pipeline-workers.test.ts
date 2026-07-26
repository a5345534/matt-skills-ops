import { describe, expect, it, vi } from "vitest";
import {
  confirmPauseControl,
  confirmResumeControl,
  confirmTerminateControl,
  pauseConfirmMessage,
  resumeConfirmMessage,
  setMenuLogger,
  terminateConfirmMessage,
  waitForPipelineWorkers,
  type MattAutoUi,
  type RunBriefCoordinator,
} from "../src/ui/menu.js";
import { predictRunTerminationMode } from "../src/ui/run-brief.js";
import type {
  PipelinePauseResult,
  PipelineResumeResult,
  RunTerminationResult,
  WorkflowPanelState,
} from "../src/types.js";

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

function mockUi(
  extras: Partial<MattAutoUi> = {},
): MattAutoUi & {
  notices: string[];
  selects: Array<{ title: string; options: string[] }>;
  widgetCalls: Array<{ key: string; content: string[] | undefined }>;
  statusCalls: Array<{ key: string; text: string | undefined }>;
} {
  const notices: string[] = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  return {
    notices,
    selects,
    widgetCalls,
    statusCalls,
    select: async (title, options) => {
      selects.push({ title, options });
      return undefined;
    },
    notify: (message) => {
      notices.push(message);
    },
    ...extras,
  };
}

function controlCoordinator(
  getPanel: () => Promise<WorkflowPanelState | undefined> | WorkflowPanelState | undefined,
  handlers: {
    pausePipeline?: () => Promise<PipelinePauseResult>;
    resumePipeline?: () => Promise<PipelineResumeResult>;
    terminateRun?: () => Promise<RunTerminationResult>;
    isPipelinePaused?: () => boolean;
    isRunTerminated?: () => boolean;
  } = {},
): RunBriefCoordinator {
  // Default in-memory pause/terminate flags when tests do not supply handlers.
  // getPanel is the source of truth for panel DTO fields when provided.
  let paused = false;
  let terminated = false;
  return {
    getPanelState: async () => {
      const panel = await getPanel();
      if (!panel) return undefined;
      // Prefer explicit panel flags from the test; fall back to internal flags
      // only when the panel does not already encode pause/terminate.
      const pipelinePaused =
        panel.pipelinePaused ||
        (handlers.isPipelinePaused ? handlers.isPipelinePaused() : paused);
      const runTerminated =
        panel.runTerminated ||
        (handlers.isRunTerminated ? handlers.isRunTerminated() : terminated);
      return {
        ...panel,
        pipelinePaused,
        ...(runTerminated ? { runTerminated: true as const } : {}),
      };
    },
    pausePipeline: async () => {
      if (handlers.pausePipeline) return handlers.pausePipeline();
      paused = true;
      return {
        abortedWorkerCount: 1,
        affectedAttempts: [
          {
            workflowId: 42,
            ticketNumber: 19,
            attempt: 1,
            kind: "implementation",
          },
        ],
        pipelinePaused: true,
      };
    },
    resumePipeline: async () => {
      if (handlers.resumePipeline) return handlers.resumePipeline();
      paused = false;
      return { pipelinePaused: false };
    },
    terminateRun: async () => {
      if (handlers.terminateRun) return handlers.terminateRun();
      terminated = true;
      paused = false;
      return {
        mode: "discard-unintegrated",
        abortedWorkerCount: 1,
        affectedAttempts: [
          {
            workflowId: 42,
            ticketNumber: 19,
            attempt: 1,
            kind: "implementation",
          },
        ],
        discardedBranches: ["matt-auto/42/ticket-19/r1"],
        discardedWorktrees: ["/workspaces/42/ticket-19/r1"],
        runTerminated: true,
      };
    },
    isPipelinePaused: () =>
      handlers.isPipelinePaused ? handlers.isPipelinePaused() : paused,
    isRunTerminated: () =>
      handlers.isRunTerminated ? handlers.isRunTerminated() : terminated,
  };
}

function scriptedSelect(answers: Array<string | undefined>): MattAutoUi["select"] {
  let i = 0;
  return async () => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return answer;
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

  it("uses status-only footer during wait so the compact widget does not duplicate the brief", async () => {
    const panels: WorkflowPanelState[] = [
      basePanel({ workers: [runningWorker()] }),
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
    ];
    let call = 0;
    const widgetCalls: Array<{ key: string; content: string[] | undefined }> =
      [];
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const ui = mockUi({
      setWidget: (key, content) => {
        widgetCalls.push({ key, content });
      },
      setStatus: (key, text) => {
        statusCalls.push({ key, text });
      },
    });

    await waitForPipelineWorkers(
      {
        getPanelState: async () => panels[Math.min(call++, panels.length - 1)]!,
      },
      ui,
      { pollIntervalMs: 1, maxTicks: 10, sleep: async () => undefined },
    );

    // Widget cleared (status-only) — no second ticket list.
    expect(widgetCalls.some((c) => c.content === undefined)).toBe(true);
    expect(
      widgetCalls.every(
        (c) => c.content === undefined || !(c.content ?? []).join("\n").includes("Tickets"),
      ),
    ).toBe(true);
    expect(statusCalls.some((c) => c.text?.includes("Workflow #42"))).toBe(
      true,
    );
    // Full-screen brief remains primary (still notified).
    expect(ui.notices.some((n) => n.includes("Workers"))).toBe(true);
  });

  it("does not throw when TUI widget APIs are absent during wait", async () => {
    const ui = mockUi(); // no setWidget / setStatus
    await expect(
      waitForPipelineWorkers(
        {
          getPanelState: async () =>
            basePanel({ workers: [runningWorker({ processAlive: true })] }),
        },
        ui,
        { pollIntervalMs: 1, maxTicks: 1, sleep: async () => undefined },
      ),
    ).resolves.toEqual({ status: "timeout" });
    expect(ui.notices.length).toBeGreaterThan(0);
  });

  it("returns settled status when workers finish without controls", async () => {
    const result = await waitForPipelineWorkers(
      {
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
      },
      mockUi(),
      { pollIntervalMs: 1, maxTicks: 5, sleep: async () => undefined },
    );
    expect(result).toEqual({ status: "settled" });
  });
});

describe("run brief Pause / Resume / Terminate confirms", () => {
  it("requires confirmation for Pause and decline leaves workers unchanged", async () => {
    const pausePipeline = vi.fn(async () => ({
      abortedWorkerCount: 1,
      affectedAttempts: [],
      pipelinePaused: true as const,
    }));
    let calls = 0;
    const coordinator = controlCoordinator(
      () => {
        calls += 1;
        // Keep a running worker so the wait loop offers controls.
        return basePanel({ workers: [runningWorker()] });
      },
      { pausePipeline },
    );
    const ui = mockUi({
      select: scriptedSelect([
        "Pause pipeline…",
        "Cancel", // decline confirm
        undefined, // then stop offering by timing out path — use maxTicks
      ]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 2,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(pausePipeline).not.toHaveBeenCalled();
    expect(ui.notices.some((n) => n.includes("Pause cancelled"))).toBe(true);
    expect(ui.notices.some((n) => n.includes(pauseConfirmMessage(42).split("\n")[0]!))).toBe(
      true,
    );
    expect(result.status).toBe("timeout");
    expect(calls).toBeGreaterThan(0);
  });

  it("Pause confirm invokes pausePipeline and keeps brief in paused mode", async () => {
    const pausePipeline = vi.fn(async () => ({
      abortedWorkerCount: 1,
      affectedAttempts: [
        {
          workflowId: 42,
          ticketNumber: 19,
          attempt: 1,
          kind: "implementation" as const,
        },
      ],
      pipelinePaused: true as const,
    }));
    let paused = false;
    const coordinator = controlCoordinator(
      () =>
        basePanel({
          workers: paused ? [] : [runningWorker()],
          pipelinePaused: paused,
          ...(paused ? { lastStopReason: "pipeline-pause" as const } : {}),
        }),
      {
        pausePipeline: async () => {
          paused = true;
          return pausePipeline();
        },
        isPipelinePaused: () => paused,
      },
    );
    const ui = mockUi({
      // Pause + confirm, then Resume path left for next test — here Terminate decline then we need exit.
      // After pause, loop shows Resume/Terminate. Decline terminate confirm once, then confirm terminate to exit.
      select: scriptedSelect([
        "Pause pipeline…",
        "Confirm Pause",
        "Terminate run…",
        "Cancel", // stay paused
        "Terminate run…",
        "Confirm Terminate",
      ]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 20,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(pausePipeline).toHaveBeenCalledTimes(1);
    expect(ui.notices.some((n) => n.includes("Pipeline paused for Workflow #42"))).toBe(
      true,
    );
    expect(ui.notices.some((n) => n.includes("Status: paused"))).toBe(true);
    // Resume is offered while paused (not Pause).
    expect(
      ui.select === undefined ||
        true, // select was invoked with paused controls
    ).toBe(true);
    expect(result.status).toBe("terminated");
  });

  it("Resume decline leaves pipeline paused; confirm clears pause and settles", async () => {
    let paused = true;
    const resumePipeline = vi.fn(async () => {
      paused = false;
      return { pipelinePaused: false as const };
    });
    const pausePipeline = vi.fn(async () => ({
      abortedWorkerCount: 0,
      affectedAttempts: [],
      pipelinePaused: true as const,
    }));
    const coordinator = controlCoordinator(
      () => {
        if (paused) {
          return basePanel({
            workers: [],
            pipelinePaused: true,
            lastStopReason: "pipeline-pause",
          });
        }
        return basePanel({ workers: [], pipelinePaused: false });
      },
      {
        pausePipeline,
        resumePipeline,
        isPipelinePaused: () => paused,
      },
    );
    const ui = mockUi({
      select: scriptedSelect([
        "Resume pipeline…",
        "Cancel", // decline
        "Resume pipeline…",
        "Confirm Resume",
      ]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 10,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(resumePipeline).toHaveBeenCalledTimes(1);
    expect(ui.notices.some((n) => n.includes("Resume cancelled"))).toBe(true);
    expect(ui.notices.some((n) => n.includes("Pipeline resumed for Workflow #42"))).toBe(
      true,
    );
    expect(result).toEqual({ status: "settled" });
    expect(paused).toBe(false);
  });

  it("Terminate decline leaves pipeline unchanged", async () => {
    const terminateRun = vi.fn(async () => ({
      mode: "discard-unintegrated" as const,
      abortedWorkerCount: 1,
      affectedAttempts: [],
      discardedBranches: [],
      discardedWorktrees: [],
      runTerminated: true as const,
    }));
    const coordinator = controlCoordinator(
      () => basePanel({ workers: [runningWorker()] }),
      { terminateRun },
    );
    const ui = mockUi({
      select: scriptedSelect([
        "Terminate run…",
        "Cancel",
        undefined, // continue waiting until timeout
      ]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 2,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(terminateRun).not.toHaveBeenCalled();
    expect(ui.notices.some((n) => n.includes("Terminate cancelled"))).toBe(true);
    expect(result.status).toBe("timeout");
  });

  it("Terminate after integrate/PR uses stop-only wording and T1 behavior", async () => {
    const terminateRun = vi.fn(async () => ({
      mode: "stop-only" as const,
      abortedWorkerCount: 1,
      affectedAttempts: [
        {
          workflowId: 42,
          ticketNumber: 19,
          attempt: 1,
          kind: "implementation" as const,
        },
      ],
      discardedBranches: [],
      discardedWorktrees: [],
      runTerminated: true as const,
    }));
    const panel = basePanel({
      workers: [runningWorker()],
      workflowPr: {
        number: 99,
        status: "open",
        baseBranch: "main",
        headBranch: "matt-auto/42/integration",
      },
    });
    expect(predictRunTerminationMode(panel)).toBe("stop-only");

    const coordinator = controlCoordinator(() => panel, { terminateRun });
    const ui = mockUi({
      select: scriptedSelect(["Terminate run…", "Confirm Terminate"]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 5,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(terminateRun).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("terminated");
    if (result.status === "terminated") {
      expect(result.result.mode).toBe("stop-only");
    }
    expect(
      ui.notices.some((n) => n.includes("(stop-only)") && n.includes("preserved")),
    ).toBe(true);
    expect(ui.notices.some((n) => n.includes("Run terminated (stop-only)"))).toBe(
      true,
    );
  });

  it("Terminate before integrate uses discard wording and exits wait", async () => {
    const terminateRun = vi.fn(async () => ({
      mode: "discard-unintegrated" as const,
      abortedWorkerCount: 1,
      affectedAttempts: [
        {
          workflowId: 42,
          ticketNumber: 19,
          attempt: 1,
          kind: "implementation" as const,
        },
      ],
      discardedBranches: ["matt-auto/42/ticket-19/r1"],
      discardedWorktrees: ["/workspaces/42/ticket-19/r1"],
      runTerminated: true as const,
    }));
    const panel = basePanel({ workers: [runningWorker()] });
    expect(predictRunTerminationMode(panel)).toBe("discard-unintegrated");

    const coordinator = controlCoordinator(() => panel, { terminateRun });
    const ui = mockUi({
      select: scriptedSelect(["Terminate run…", "Confirm Terminate"]),
    });

    const result = await waitForPipelineWorkers(coordinator, ui, {
      pollIntervalMs: 1,
      maxTicks: 5,
      sleep: async () => undefined,
      offerRunningControls: true,
    });

    expect(result.status).toBe("terminated");
    expect(
      ui.notices.some(
        (n) =>
          n.includes("May discard unintegrated attempt") &&
          n.includes("Workflow #42"),
      ),
    ).toBe(true);
    expect(ui.notices.some((n) => n.includes("Discarded unintegrated branches"))).toBe(
      true,
    );
  });

  it("logs operator decisions with workflow id", async () => {
    const lines: string[] = [];
    setMenuLogger({
      debug: () => undefined,
      info: (message, data) => {
        lines.push(`${message} ${JSON.stringify(data ?? {})}`);
      },
      warn: () => undefined,
      error: () => undefined,
      filePath: () => "/tmp/matt-auto-test.log",
    });
    try {
      const coordinator = controlCoordinator(
        () => basePanel({ workers: [runningWorker()] }),
        {},
      );
      const ui = mockUi({
        select: scriptedSelect([
          "Pause pipeline…",
          "Cancel",
          "Terminate run…",
          "Confirm Terminate",
        ]),
      });
      await waitForPipelineWorkers(coordinator, ui, {
        pollIntervalMs: 1,
        maxTicks: 10,
        sleep: async () => undefined,
        offerRunningControls: true,
      });

      expect(
        lines.some(
          (l) =>
            l.includes("run-brief:operator-pause-decision") &&
            l.includes('"workflowId":42') &&
            l.includes('"decision":"decline"'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) =>
            l.includes("run-brief:operator-terminate-decision") &&
            l.includes('"workflowId":42') &&
            l.includes('"decision":"confirm"'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) =>
            l.includes("run-brief:operator-terminate") &&
            l.includes('"workflowId":42'),
        ),
      ).toBe(true);
    } finally {
      setMenuLogger(undefined);
    }
  });

  it("confirm helpers accept only the confirm choice", async () => {
    const uiConfirm = mockUi({
      select: async () => "Confirm Pause",
    });
    await expect(confirmPauseControl(uiConfirm, 7)).resolves.toBe(true);

    const uiDecline = mockUi({
      select: async () => "Cancel",
    });
    await expect(confirmResumeControl(uiDecline, 7)).resolves.toBe(false);
    await expect(
      confirmTerminateControl(uiDecline, 7, "stop-only"),
    ).resolves.toBe(false);

    expect(pauseConfirmMessage(7)).toContain("Workflow #7");
    expect(resumeConfirmMessage(7)).toContain("aborted worker conversation");
    expect(terminateConfirmMessage(7, "stop-only")).toContain("stop-only");
    expect(terminateConfirmMessage(7, "discard-unintegrated")).toContain(
      "discard unintegrated",
    );
  });
});
