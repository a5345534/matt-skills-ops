import { describe, expect, it } from "vitest";
import {
  buildRunBriefViewModel,
  deriveContextLabel,
  formatLastTurnStartedAt,
  formatRunBriefLines,
  formatRuntimeMs,
  freeReadyFrontierTickets,
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
          workerProfile: {
            provider: "openai-codex",
            modelId: "gpt-5.6-terra",
            thinkingLevel: "max",
          },
          turnCount: 4,
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
      completedWorkerRuns: [
        {
          workflowId: 42,
          ticketNumber: 40,
          attempt: 1,
          kind: "implementation",
          turnCount: 7,
          runtimeMs: 125_000,
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
    expect(byId.pipeline?.lines[0]).toBe("Status: running");
    expect(byId.context?.lines).toEqual(["Implementing #43 r2"]);
    // Ticket table present → Workers is a single progress line (no path dump).
    expect(byId.workers?.lines).toEqual([
      "#43 r2: running · model=openai-codex/gpt-5.6-terra:max — Running tests",
      "  turns: 4 · last turn: —",
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
    expect(byId.tickets?.lines[1]).toContain("TURNS");
    expect(byId.tickets?.lines[2]).toMatch(/^-+/);
    // Aligned table rows (S1 by number; completed attempts retain runtime/turns).
    const ticketBody = byId.tickets?.lines.slice(3).join("\n") ?? "";
    expect(ticketBody).toContain("#40");
    expect(ticketBody).toContain("2m05s");
    expect(ticketBody).toContain("7");
    expect(ticketBody).toContain("closed r1");
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

  it("shows Implementation recovery cooldown with observed reason", () => {
    const brief = buildRunBriefViewModel(
      basePanel({
        implementationRecovery: [
          {
            ticketNumber: 44,
            sinceMs: Date.parse("2026-07-29T02:05:00.000Z"),
            untilMs: Date.parse("2026-07-29T02:35:00.000Z"),
            remainingMs: 20 * 60_000,
            reason: "Codex error: The usage limit has been reached",
          },
        ],
      }),
    );
    const recovery = brief.sections.find((section) => section.id === "recovery");
    expect(recovery?.title).toBe("Implementation recovery");
    expect(recovery?.lines.join("\n")).toContain("#44: cooling");
    expect(recovery?.lines.join("\n")).toContain(
      "Codex error: The usage limit has been reached",
    );
  });

  it("shows legacy transcript turns without inventing runtime", () => {
    const brief = buildRunBriefViewModel(
      basePanel({
        completedWorkerRuns: [
          {
            workflowId: 42,
            ticketNumber: 43,
            attempt: 1,
            kind: "implementation",
            turnCount: 56,
          },
        ],
        ticketProgress: {
          workflowId: 42,
          total: 1,
          open: 0,
          closed: 1,
          ready: [],
          blocked: [],
          awaitingCi: [],
          items: [
            {
              number: 43,
              title: "Closed ticket",
              state: "CLOSED",
              status: "closed",
            },
          ],
        },
      }),
    );

    const row = brief.sections.find((section) => section.id === "tickets")?.lines[3];
    expect(row).toContain("#43");
    expect(row).toContain("56");
    expect(row).toContain("closed r1");
    expect(row).toContain("—");
  });

  it("omits optional rows gracefully when fields are missing", () => {
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 43,
          attempt: 1,
          status: "needs-disposition",
          branchName: "matt-auto/42/ticket-43/r1",
          workerProfile: {
            provider: "anthropic",
            modelId: "claude-sonnet-4",
            thinkingLevel: "medium",
          },
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
    expect(brief.sections.find((s) => s.id === "pipeline")?.lines[0]).toBe(
      "Status: running",
    );
    expect(brief.sections.find((s) => s.id === "context")?.lines).toEqual([
      "Needs disposition #43 r1",
    ]);
    expect(brief.sections.find((s) => s.id === "workers")?.lines).toEqual([
      "#43 r1: needs-disposition",
      "  model: anthropic/claude-sonnet-4:medium",
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
    expect(paused.sections.find((s) => s.id === "pipeline")?.lines[0]).toBe(
      "Status: paused",
    );
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
    expect(terminated.sections.find((s) => s.id === "pipeline")?.lines[0]).toBe(
      "Status: terminated",
    );
    expect(terminated.sections.find((s) => s.id === "stop")?.lines).toEqual([
      "Last stop: run termination",
      "Termination mode: discard unintegrated attempts",
    ]);
  });

  it("formats latest worker turn with a stable timestamp and age", () => {
    expect(formatLastTurnStartedAt(1_700_000_000_000, 1_700_000_065_000)).toBe(
      "22:13:20Z (1m05s ago)",
    );
  });

  it("shows total run elapsed on the Pipeline section", () => {
    const brief = buildRunBriefViewModel(
      basePanel({ runElapsedMs: 125_000 }),
    );
    expect(brief.sections.find((s) => s.id === "pipeline")?.lines).toEqual([
      "Status: running",
      `Elapsed: ${formatRuntimeMs(125_000)}`,
    ]);
  });

  it("can omit Controls when the live surface owns Pause/Terminate", () => {
    const withControls = buildRunBriefViewModel(basePanel());
    expect(withControls.sections.some((s) => s.id === "controls")).toBe(true);
    const without = buildRunBriefViewModel(basePanel(), { omitControls: true });
    expect(without.sections.some((s) => s.id === "controls")).toBe(false);
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

  it("does not show tracker ready for a ticket that needs disposition", () => {
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 55,
          attempt: 1,
          status: "needs-disposition",
          branchName: "matt-auto/53/ticket-55/r1",
          progress: "I'll start by reading the issue details…",
          turnCount: 14,
          workerProfile: {
            provider: "grok-cli",
            modelId: "grok-4.5",
            thinkingLevel: "high",
          },
        },
      ],
      ticketProgress: {
        workflowId: 53,
        total: 3,
        open: 2,
        closed: 1,
        ready: [
          { number: 55, title: "Tests: home Start new" },
          { number: 56, title: "README" },
        ],
        blocked: [],
        awaitingCi: [],
        items: [
          {
            number: 54,
            title: "Always show Start new",
            state: "CLOSED",
            status: "closed",
          },
          {
            number: 55,
            title: "Tests: home Start new",
            state: "OPEN",
            status: "ready",
          },
          {
            number: 56,
            title: "README",
            state: "OPEN",
            status: "ready",
          },
        ],
      },
    });

    expect(deriveContextLabel(panel)).toBe("Needs disposition #55 r1");
    expect(freeReadyFrontierTickets(panel).map((t) => t.number)).toEqual([56]);
    // Without session workers, frontier lists all tracker-ready tickets.
    expect(
      deriveContextLabel({
        ...panel,
        workers: [],
      }),
    ).toBe("Ready frontier: #55, #56");

    const brief = buildRunBriefViewModel(panel);
    const ticketBody = brief.sections.find((s) => s.id === "tickets")?.lines.join("\n") ?? "";
    // READY/BLOCK must not say ready while STATUS is needs-disp.
    const row55 = ticketBody
      .split("\n")
      .find((line) => line.includes("#55"));
    expect(row55).toBeDefined();
    expect(row55).toMatch(/needs-disp/);
    expect(row55).not.toMatch(/\bready\b/);

    const row56 = ticketBody.split("\n").find((line) => line.includes("#56"));
    expect(row56).toMatch(/\bready\b/);

    // Stale implement progress is not shown once disposition is pending.
    const workerLines = brief.sections.find((s) => s.id === "workers")?.lines.join("\n") ?? "";
    expect(workerLines).toContain("needs-disposition");
    expect(workerLines).not.toContain("I'll start by reading");
  });

  it("shows integrating READY/BLOCK and live Integration elapsed, not stale fail reason", () => {
    const panel = basePanel({
      integration: {
        ticketNumber: 55,
        attempt: 1,
        status: "running",
        branchName: "matt-auto/53/ticket-55/r1",
        reason:
          "Local verification failed in the Integration workspace: typecheck failed",
        runtimeMs: 33_000,
      },
      ticketProgress: {
        workflowId: 53,
        total: 3,
        open: 2,
        closed: 1,
        ready: [
          { number: 55, title: "Tests" },
          { number: 56, title: "README" },
        ],
        blocked: [],
        awaitingCi: [],
        items: [
          {
            number: 54,
            title: "Always show",
            state: "CLOSED",
            status: "closed",
          },
          {
            number: 55,
            title: "Tests",
            state: "OPEN",
            status: "ready",
          },
          {
            number: 56,
            title: "README",
            state: "OPEN",
            status: "ready",
          },
        ],
      },
    });

    expect(deriveContextLabel(panel)).toBe("Integrating #55 r1");
    expect(freeReadyFrontierTickets(panel).map((t) => t.number)).toEqual([56]);

    const brief = buildRunBriefViewModel(panel);
    const integration = brief.sections
      .find((s) => s.id === "integration")
      ?.lines.join("\n") ?? "";
    expect(integration).toContain("running");
    expect(integration).toContain("elapsed:");
    expect(integration).toContain("33s");
    // Prior attempt failure must not freeze under a running unit.
    expect(integration).not.toContain("typecheck failed");

    const row55 = brief.sections
      .find((s) => s.id === "tickets")
      ?.lines.find((l) => l.includes("#55"));
    expect(row55).toMatch(/integrating/);
    expect(row55).toMatch(/33s/);
    expect(row55).not.toMatch(/\bready\b/);
  });

  it("lists only free ready tickets when context falls through to frontier", () => {
    // No live workers needing disposition — but if we only had ready tickets
    // with no workers, frontier shows all. When one is running, exclude it.
    const panel = basePanel({
      workers: [
        {
          ticketNumber: 55,
          attempt: 1,
          status: "running",
          branchName: "matt-auto/53/ticket-55/r1",
        },
      ],
      ticketProgress: {
        workflowId: 53,
        total: 2,
        open: 2,
        closed: 0,
        ready: [
          { number: 55, title: "A" },
          { number: 56, title: "B" },
        ],
        blocked: [],
        awaitingCi: [],
        items: [
          {
            number: 55,
            title: "A",
            state: "OPEN",
            status: "ready",
          },
          {
            number: 56,
            title: "B",
            state: "OPEN",
            status: "ready",
          },
        ],
      },
    });
    // Running worker wins context.
    expect(deriveContextLabel(panel)).toBe("Implementing #55 r1");
    const row55 = buildRunBriefViewModel(panel)
      .sections.find((s) => s.id === "tickets")
      ?.lines.find((l) => l.includes("#55"));
    expect(row55).toMatch(/running/);
    expect(row55).not.toMatch(/\bready\b/);
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
