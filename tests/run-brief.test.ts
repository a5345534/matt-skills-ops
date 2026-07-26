import { describe, expect, it } from "vitest";
import {
  buildRunBriefViewModel,
  deriveContextLabel,
  formatRunBriefLines,
  predictRunTerminationMode,
} from "../src/ui/run-brief.js";
import type { WorkflowPanelState } from "../src/types.js";

function basePanel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 42,
    lines: ["Workflow #42"],
    workers: [],
    pipelinePaused: false,
    ...overrides,
  };
}

describe("buildRunBriefViewModel", () => {
  it("maps a full fixture panel DTO into expected brief sections", () => {
    const panel = basePanel({
      title: "Ship run brief",
      pipelinePaused: false,
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
          progress: "Running tests",
        },
      ],
      integration: {
        ticketNumber: 44,
        attempt: 1,
        status: "pending-retry",
        branchName: "matt-auto/42/ticket-44/r1",
        reason: "Local verification failed",
      },
      ci: [
        {
          ticketNumber: 41,
          attempt: 1,
          status: "awaiting-check",
          integrationBranch: "matt-auto/42/integration",
        },
        {
          ticketNumber: 40,
          attempt: 1,
          status: "failure",
          integrationBranch: "matt-auto/42/integration",
          summary: "ci / test failed",
          url: "https://example.test/ci/40",
        },
      ],
      workflowPr: {
        number: 99,
        status: "open",
        url: "https://example.test/pr/99",
        baseBranch: "main",
        headBranch: "matt-auto/42/integration",
      },
      ticketProgress: {
        workflowId: 42,
        total: 4,
        open: 3,
        closed: 1,
        ready: [{ number: 45, title: "Ready ticket" }],
        blocked: [{ number: 46, title: "Blocked", openBlockers: [45] }],
        awaitingCi: [{ number: 41, title: "Awaiting" }],
        items: [
          {
            number: 40,
            title: "Closed ticket",
            state: "CLOSED",
            status: "closed",
          },
          {
            number: 41,
            title: "Awaiting",
            state: "OPEN",
            status: "awaiting-ci",
          },
          {
            number: 45,
            title: "Ready ticket",
            state: "OPEN",
            status: "ready",
          },
          {
            number: 46,
            title: "Blocked",
            state: "OPEN",
            status: "blocked",
            openBlockers: [45],
          },
        ],
      },
      lastStopReason: "pipeline-pause",
    });

    const brief = buildRunBriefViewModel(panel);
    const byId = Object.fromEntries(
      brief.sections.map((s) => [s.id, s]),
    );

    expect(byId.workflow?.lines).toEqual(["Workflow #42: Ship run brief"]);
    expect(byId.pipeline?.lines).toEqual(["Status: running"]);
    expect(byId.context?.lines).toEqual(["Implementing #43 r2"]);
    // Ticket table present → Workers is a single progress line (no path dump).
    expect(byId.workers?.lines).toEqual([
      "#43 r2: running — Running tests",
    ]);
    expect(byId.integration?.lines).toEqual([
      "#44 r1: pending-retry",
      "  branch: matt-auto/42/ticket-44/r1",
      "  reason: Local verification failed",
    ]);
    expect(byId.ci?.lines).toEqual([
      "#41 r1: awaiting-check",
      "  integrationBranch: matt-auto/42/integration",
      "#40 r1: failure",
      "  integrationBranch: matt-auto/42/integration",
      "  summary: ci / test failed",
      "  url: https://example.test/ci/40",
    ]);
    expect(byId["workflow-pr"]?.lines).toEqual([
      "PR #99: open",
      "  matt-auto/42/integration → main",
      "  url: https://example.test/pr/99",
    ]);
    expect(byId.tickets?.lines[0]).toBe(
      "Summary: 1 ready / 3 open / 1 closed (total 4)",
    );
    expect(byId.tickets?.lines[1]).toMatch(/^#\s+READY\/BLOCK/);
    expect(byId.tickets?.lines[2]).toMatch(/^-+/);
    // Aligned table rows (S1 by number; R1 runtime only when worker present).
    const ticketBody = byId.tickets?.lines.slice(3).join("\n") ?? "";
    expect(ticketBody).toContain("#40");
    expect(ticketBody).toContain("closed");
    expect(ticketBody).toContain("Closed ticket");
    expect(ticketBody).toContain("#41");
    expect(ticketBody).toMatch(/awaiting-ci|ci:awaiting/);
    expect(ticketBody).toContain("#45");
    expect(ticketBody).toMatch(/ready/);
    expect(ticketBody).toContain("#46");
    expect(ticketBody).toMatch(/blocked by #45/);
    // Column alignment: header and first data row same length structure
    const header = byId.tickets!.lines[1]!;
    const row = byId.tickets!.lines[3]!;
    expect(row.length).toBe(header.length);
    expect(byId.stop?.lines).toEqual(["Last stop: pipeline pause"]);

    // Flat lines include section titles and are free of invented dashboard chrome.
    expect(brief.lines).toEqual(formatRunBriefLines(brief));
    expect(brief.lines.join("\n")).toContain("Workflow #42: Ship run brief");
    expect(brief.lines.join("\n")).not.toMatch(/\[x\]|click|button/i);
  });

  it("omits optional rows gracefully when fields are missing", () => {
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 43,
          attempt: 1,
          status: "needs-disposition",
          branchName: "matt-auto/42/ticket-43/r1",
          // no workerId, pid, processAlive, worktree, transcript, progress
        },
      ],
      // no title, integration, ci, workflowPr, ticketProgress, stop fields
    });

    const brief = buildRunBriefViewModel(panel);
    const ids = brief.sections.map((s) => s.id);

    expect(ids).toEqual([
      "workflow",
      "pipeline",
      "context",
      "workers",
      "controls",
    ]);
    expect(brief.sections.find((s) => s.id === "workflow")?.lines).toEqual([
      "Workflow #42",
    ]);
    expect(brief.sections.find((s) => s.id === "pipeline")?.lines).toEqual([
      "Status: running",
    ]);
    expect(brief.sections.find((s) => s.id === "context")?.lines).toEqual([
      "Needs disposition #43 r1",
    ]);
    expect(brief.sections.find((s) => s.id === "workers")?.lines).toEqual([
      "#43 r1: needs-disposition",
      "  branch: matt-auto/42/ticket-43/r1",
    ]);
    expect(brief.sections.find((s) => s.id === "controls")?.lines.join("\n")).toMatch(
      /Live:|select menu|Pause/,
    );
    // Missing optional sections are absent, not empty placeholders that throw.
    expect(ids).not.toContain("integration");
    expect(ids).not.toContain("ci");
    expect(ids).not.toContain("workflow-pr");
    expect(ids).not.toContain("tickets");
    expect(ids).not.toContain("stop");
  });

  it("shows paused and terminated pipeline states with stop reason", () => {
    const paused = buildRunBriefViewModel(
      basePanel({
        pipelinePaused: true,
        lastStopReason: "pipeline-pause",
      }),
    );
    expect(paused.sections.find((s) => s.id === "pipeline")?.lines).toEqual([
      "Status: paused",
    ]);
    expect(paused.sections.find((s) => s.id === "stop")?.lines).toEqual([
      "Last stop: pipeline pause",
    ]);
    expect(deriveContextLabel(basePanel({ pipelinePaused: true }))).toBe(
      "Pipeline paused",
    );

    const terminated = buildRunBriefViewModel(
      basePanel({
        pipelinePaused: false,
        runTerminated: true,
        lastStopReason: "run-termination",
        terminationMode: "discard-unintegrated",
      }),
    );
    expect(terminated.sections.find((s) => s.id === "pipeline")?.lines).toEqual([
      "Status: terminated",
    ]);
    expect(terminated.sections.find((s) => s.id === "stop")?.lines).toEqual([
      "Last stop: run termination",
      "Termination mode: discard unintegrated attempts",
    ]);
  });

  it("prefers worker inspection over generic paused context", () => {
    const panel = basePanel({
      pipelinePaused: true,
      workers: [
        {
          ticketNumber: 7,
          attempt: 1,
          status: "running",
          workerId: "implement-42-7-r1",
          processAlive: false,
          branchName: "matt-auto/42/ticket-7/r1",
        },
      ],
    });
    expect(deriveContextLabel(panel)).toBe("Implementing #7 r1");
    const workerLines = buildRunBriefViewModel(panel).sections.find(
      (s) => s.id === "workers",
    )?.lines;
    expect(workerLines).toContain("  processAlive: false");
    expect(workerLines).toContain("  workerId: implement-42-7-r1");
  });

  it("surfaces conflict-resolution and CI failure context", () => {
    expect(
      deriveContextLabel(
        basePanel({
          integration: {
            ticketNumber: 10,
            attempt: 3,
            status: "conflict-resolution",
            branchName: "matt-auto/42/integration",
          },
        }),
      ),
    ).toBe("Conflict resolution #10 r3");

    expect(
      deriveContextLabel(
        basePanel({
          ci: [
            {
              ticketNumber: 11,
              attempt: 1,
              status: "failure",
              integrationBranch: "matt-auto/42/integration",
              summary: "red",
            },
          ],
        }),
      ),
    ).toBe("CI recovery #11 r1");
  });

  it("does not throw on a minimal empty-worker panel", () => {
    expect(() => buildRunBriefViewModel(basePanel())).not.toThrow();
    const brief = buildRunBriefViewModel(basePanel());
    expect(brief.sections.map((s) => s.id)).toEqual([
      "workflow",
      "pipeline",
      "controls",
    ]);
    expect(brief.lines.length).toBeGreaterThan(0);
  });
});

describe("predictRunTerminationMode", () => {
  it("defaults to discard-unintegrated before any integrate/PR", () => {
    expect(predictRunTerminationMode(basePanel())).toBe("discard-unintegrated");
  });

  it("is stop-only when a Workflow PR exists", () => {
    expect(
      predictRunTerminationMode(
        basePanel({
          workflowPr: {
            number: 1,
            status: "open",
            baseBranch: "main",
            headBranch: "matt-auto/42/integration",
          },
        }),
      ),
    ).toBe("stop-only");
  });

  it("is stop-only when CI or closed/awaiting-CI ticket progress shows integrate", () => {
    expect(
      predictRunTerminationMode(
        basePanel({
          ci: [
            {
              ticketNumber: 1,
              attempt: 1,
              status: "awaiting-check",
              integrationBranch: "matt-auto/42/integration",
            },
          ],
        }),
      ),
    ).toBe("stop-only");

    expect(
      predictRunTerminationMode(
        basePanel({
          ticketProgress: {
            workflowId: 42,
            total: 2,
            open: 1,
            closed: 1,
            ready: [],
            blocked: [],
            awaitingCi: [],
            items: [],
          },
        }),
      ),
    ).toBe("stop-only");

    expect(
      predictRunTerminationMode(
        basePanel({
          ticketProgress: {
            workflowId: 42,
            total: 2,
            open: 2,
            closed: 0,
            ready: [],
            blocked: [],
            awaitingCi: [{ number: 1, title: "Integrated" }],
            items: [
              {
                number: 1,
                title: "Integrated",
                state: "OPEN",
                status: "awaiting-ci",
              },
            ],
          },
        }),
      ),
    ).toBe("stop-only");
  });
});
