import { describe, expect, it, vi } from "vitest";
import type { WorkflowPanelState } from "../src/types.js";
import {
  buildCompactWorkflowPanel,
  clearWorkflowPanel,
  formatCompactWorkflowPanelLines,
  publishWorkflowPanel,
  WORKFLOW_PANEL_STATUS_KEY,
  WORKFLOW_PANEL_WIDGET_KEY,
} from "../src/ui/workflow-panel.js";
import { formatPanelLines } from "../src/ui/menu.js";

function basePanel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 42,
    lines: ["Workflow #42 — coordinator-owned legacy line (must not be used)"],
    workers: [],
    pipelinePaused: false,
    ...overrides,
  };
}

describe("buildCompactWorkflowPanel", () => {
  it("derives condensed lines from the same panel DTO as the brief", () => {
    const panel = basePanel({
      title: "Ship compact panel",
      workers: [
        {
          ticketNumber: 43,
          attempt: 2,
          status: "running",
          workerId: "implement-42-43-r2",
          pid: 4242,
          processAlive: true,
          branchName: "matt-auto/42/ticket-43/r2",
          worktreePath: "/workspaces/42/ticket-43/r2",
          transcriptPath: "/transcripts/42/ticket-43/r2.jsonl",
          workerProfile: {
            provider: "openai-codex",
            modelId: "gpt-5.6-terra",
            thinkingLevel: "max",
          },
          progress: "Running tests",
        },
      ],
    });

    const vm = buildCompactWorkflowPanel(panel);
    expect(vm.visible).toBe(true);
    expect(vm.lines[0]).toBe("Workflow #42: Ship compact panel");
    expect(vm.lines).toContain("Implementing #43 r2");
    expect(vm.lines).toContain(
      "#43 r2: running · alive · model=openai-codex/gpt-5.6-terra:max — Running tests",
    );
    // Does not invent dashboard chrome or re-read GitHub.
    expect(vm.lines.join("\n")).not.toMatch(/\[x\]|click|button|Next actions/i);
    // Ignores coordinator-owned panel.lines — structured DTO is the source.
    expect(vm.lines.join("\n")).not.toContain("coordinator-owned legacy line");
    expect(vm.statusLine).toContain("Workflow #42");
    expect(vm.statusLine).toContain("Implementing #43 r2");
  });

  it("shows paused / terminated pipeline state on the Workflow panel", () => {
    const paused = buildCompactWorkflowPanel(
      basePanel({ pipelinePaused: true }),
    );
    expect(paused.visible).toBe(true);
    expect(paused.lines[0]).toBe("Workflow #42 · paused");
    expect(paused.statusLine).toContain("paused");

    const terminated = buildCompactWorkflowPanel(
      basePanel({
        runTerminated: true,
        lastStopReason: "run-termination",
        terminationMode: "stop-only",
      }),
    );
    expect(terminated.lines[0]).toBe("Workflow #42 · terminated");
    expect(terminated.statusLine).toContain("terminated");
  });

  it("surfaces process-gone workers without full brief path dump", () => {
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 7,
          attempt: 1,
          status: "running",
          processAlive: false,
          branchName: "matt-auto/42/ticket-7/r1",
          progress: "hung",
        },
      ],
    });
    const lines = formatCompactWorkflowPanelLines(panel);
    expect(lines).toContain("#7 r1: running · process gone — hung");
    expect(lines.join("\n")).not.toContain("worktree:");
    expect(lines.join("\n")).not.toContain("transcript:");
  });

  it("includes compact integration / CI / PR when no workers are listed", () => {
    const panel = basePanel({
      integration: {
        ticketNumber: 10,
        attempt: 3,
        status: "conflict-resolution",
        branchName: "matt-auto/42/integration",
        reason: "merge conflict",
      },
      workflowPr: {
        number: 99,
        status: "open",
        baseBranch: "main",
        headBranch: "matt-auto/42/integration",
      },
    });
    // integration present → workers empty path; conflict context + integration line
    const vm = buildCompactWorkflowPanel(panel);
    expect(vm.lines.some((l) => /Conflict resolution #10 r3/.test(l))).toBe(
      true,
    );
    expect(
      vm.lines.some((l) =>
        /Integration #10 r3: conflict-resolution — merge conflict/.test(l),
      ),
    ).toBe(true);
  });

  it("formatPanelLines uses the compact DTO builder, not panel.lines", () => {
    const panel = basePanel({
      title: "Menu path",
      pipelinePaused: true,
      workers: [
        {
          ticketNumber: 1,
          attempt: 1,
          status: "running",
          processAlive: true,
          branchName: "matt-auto/42/ticket-1/r1",
        },
      ],
    });
    expect(formatPanelLines(panel)).toEqual(
      formatCompactWorkflowPanelLines(panel),
    );
    expect(formatPanelLines(panel)).not.toEqual([...panel.lines]);
  });
});

describe("publishWorkflowPanel", () => {
  it("is a graceful no-op when TUI widget APIs are missing", () => {
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 1,
          attempt: 1,
          status: "running",
          branchName: "b",
        },
      ],
    });
    expect(() => publishWorkflowPanel({}, panel)).not.toThrow();
    const vm = publishWorkflowPanel({}, panel);
    expect(vm?.visible).toBe(true);
    expect(vm?.lines[0]).toContain("Workflow #42");
  });

  it("publishes widget lines and status from the same DTO when APIs exist", () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const panel = basePanel({
      title: "Widget feed",
      pipelinePaused: true,
      workers: [
        {
          ticketNumber: 9,
          attempt: 1,
          status: "running",
          processAlive: true,
          branchName: "matt-auto/42/ticket-9/r1",
          progress: "compiling",
        },
      ],
    });

    const vm = publishWorkflowPanel({ setWidget, setStatus }, panel);
    expect(vm?.visible).toBe(true);
    expect(setWidget).toHaveBeenCalledWith(
      WORKFLOW_PANEL_WIDGET_KEY,
      expect.arrayContaining([
        "Workflow #42: Widget feed · paused",
        "#9 r1: running · alive — compiling",
      ]),
    );
    expect(setStatus).toHaveBeenCalledWith(
      WORKFLOW_PANEL_STATUS_KEY,
      expect.stringContaining("paused"),
    );
  });

  it("clears the Workflow panel when there is no visible state", () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    clearWorkflowPanel({ setWidget, setStatus });
    expect(setWidget).toHaveBeenCalledWith(
      WORKFLOW_PANEL_WIDGET_KEY,
      undefined,
    );
    expect(setStatus).toHaveBeenCalledWith(
      WORKFLOW_PANEL_STATUS_KEY,
      undefined,
    );
  });

  it("swallows host errors so missing/broken widget support cannot break run", () => {
    const setWidget = vi.fn(() => {
      throw new Error("no TUI");
    });
    expect(() =>
      publishWorkflowPanel(
        { setWidget },
        basePanel({
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
    ).not.toThrow();
  });
});
