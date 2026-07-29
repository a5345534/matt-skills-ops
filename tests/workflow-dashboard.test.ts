import { describe, expect, it } from "vitest";
import type {
  NextAction,
  PreflightResult,
  TicketProgressSummary,
  WorkflowPanelState,
} from "../src/types.js";
import {
  buildWorkflowDashboardViewModel,
  switchWorkflowRowKey,
  nextActionRowKey,
  preflightRowKey,
  ticketRowKey,
  workerAttemptRowKey,
  WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY,
} from "../src/ui/workflow-dashboard.js";

function basePanel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 42,
    lines: ["legacy panel line is not dashboard input"],
    workers: [],
    pipelinePaused: false,
    ...overrides,
  };
}

function fullProgress(): TicketProgressSummary {
  return {
    workflowId: 42,
    total: 5,
    open: 5,
    closed: 0,
    ready: [
      { number: 43, title: "Running ticket" },
      { number: 46, title: "Integration ticket" },
      { number: 47, title: "No active worker" },
    ],
    blocked: [
      { number: 44, title: "Blocked disposition", openBlockers: [43] },
    ],
    awaitingCi: [{ number: 45, title: "Waiting on CI" }],
    items: [
      {
        number: 43,
        title: "Running ticket",
        state: "OPEN",
        status: "ready",
      },
      {
        number: 44,
        title: "Blocked disposition",
        state: "OPEN",
        status: "blocked",
        openBlockers: [43],
      },
      {
        number: 45,
        title: "Waiting on CI",
        state: "OPEN",
        status: "awaiting-ci",
      },
      {
        number: 46,
        title: "Integration ticket",
        state: "OPEN",
        status: "ready",
      },
      {
        number: 47,
        title: "No active worker",
        state: "OPEN",
        status: "ready",
      },
    ],
  };
}

function preflight(): PreflightResult {
  return {
    ok: true,
    targetBranch: "main",
    workerProfile: {
      profile: {
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        thinkingLevel: "max",
      },
      source: "workflow-snapshot",
    },
    checks: [
      {
        id: "worker-profile",
        ok: true,
        guidance: "Worker profile is configured.",
      },
      { id: "gh-auth", ok: true, guidance: "GitHub authentication is valid." },
      { id: "github-remote", ok: true, guidance: "GitHub remote is valid." },
      { id: "target-branch", ok: true, guidance: "Target branch is main." },
      { id: "matt-skills", ok: true, guidance: "Required skills are installed." },
    ],
  };
}

function actions(): NextAction[] {
  return [
    {
      id: "implement:43",
      label: "Implement #43",
      description: "Start the ready ticket.",
    },
    {
      id: "check-ci:45",
      label: "Check CI #45",
      description: "Check the Integration branch CI gate.",
    },
  ];
}

function fullPanel(): WorkflowPanelState {
  return basePanel({
    title: "Dashboard detail fixture",
    workers: [
      {
        ticketNumber: 43,
        attempt: 2,
        status: "running",
        workerId: "implement-42-43-r2",
        workerProfile: {
          provider: "openai-codex",
          modelId: "gpt-5.6-terra",
          thinkingLevel: "max",
        },
        pid: 4242,
        processAlive: true,
        progress: "Running tests",
        turnCount: 4,
        lastTurnStartedAtMs: 1_700_000_000_000,
        startedAtMs: 1_699_999_000_000,
        runtimeMs: 125_000,
        branchName: "matt-auto/42/ticket-43/r2",
        worktreePath: "/workspaces/42/ticket-43/r2",
        transcriptPath: "/transcripts/42/ticket-43/r2.jsonl",
      },
      {
        ticketNumber: 44,
        attempt: 1,
        status: "needs-disposition",
        workerProfile: {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          thinkingLevel: "medium",
        },
        processAlive: false,
        branchName: "matt-auto/42/ticket-44/r1",
        worktreePath: "/workspaces/42/ticket-44/r1",
      },
    ],
    integration: {
      ticketNumber: 46,
      attempt: 3,
      status: "pending-retry",
      branchName: "matt-auto/42/integration",
      reason: "Local verification failed",
    },
    ci: [
      {
        ticketNumber: 45,
        attempt: 1,
        status: "failure",
        integrationBranch: "matt-auto/42/integration",
        summary: "ci / test failed",
        url: "https://example.test/ci/45",
      },
    ],
    workflowPr: {
      number: 99,
      status: "open",
      headBranch: "matt-auto/42/integration",
      baseBranch: "main",
      url: "https://example.test/pr/99",
    },
    ticketProgress: fullProgress(),
  });
}

function detailLines(
  key: string,
  panel: WorkflowPanelState = fullPanel(),
): readonly string[] {
  return buildWorkflowDashboardViewModel(
    { panel, preflight: preflight(), nextActions: actions() },
    { selectedKey: key, nowMs: 1_700_000_065_000 },
  ).selectedDetail.lines;
}

describe("buildWorkflowDashboardViewModel", () => {
  it("uses stable row keys rather than rendered ticket, worker, preflight, or action text", () => {
    const vm = buildWorkflowDashboardViewModel(
      { panel: fullPanel(), preflight: preflight(), nextActions: actions() },
      { nowMs: 1_700_000_065_000 },
    );

    expect(vm.rows.map((row) => row.key)).toEqual([
      WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY,
      ticketRowKey(43),
      ticketRowKey(44),
      ticketRowKey(45),
      ticketRowKey(46),
      ticketRowKey(47),
      workerAttemptRowKey(43, 2),
      workerAttemptRowKey(44, 1),
      preflightRowKey("github-remote"),
      preflightRowKey("gh-auth"),
      preflightRowKey("target-branch"),
      preflightRowKey("matt-skills"),
      preflightRowKey("worker-profile"),
      switchWorkflowRowKey(),
      nextActionRowKey("implement:43"),
      nextActionRowKey("check-ci:45"),
    ]);
    expect(vm.rows.find((row) => row.key === ticketRowKey(43))?.label).toBe(
      "#43 — Running ticket",
    );
    expect(vm.rows.find((row) => row.key === nextActionRowKey("implement:43"))?.key).toBe(
      "action:implement:43",
    );
  });

  it("shows all supplied running-worker model, process, turn, and workspace context", () => {
    const lines = detailLines(workerAttemptRowKey(43, 2));

    expect(lines).toContain("Status: running");
    expect(lines).toContain("Model: openai-codex/gpt-5.6-terra:max");
    expect(lines).toContain("Worker id: implement-42-43-r2");
    expect(lines).toContain("PID: 4242");
    expect(lines).toContain("Process: alive");
    expect(lines).toContain("Runtime: 2m05s");
    expect(lines).toContain(
      "Telemetry: turns: 4 · last turn: 22:13:20Z (1m05s ago)",
    );
    expect(lines).toContain("Progress: Running tests");
    expect(lines).toContain("Branch: matt-auto/42/ticket-43/r2");
    expect(lines).toContain("Worktree: /workspaces/42/ticket-43/r2");
    expect(lines).toContain(
      "Transcript: /transcripts/42/ticket-43/r2.jsonl",
    );
    expect(lines).toContain("Ticket workflow status: ready");
    expect(lines).toContain("Readiness: ready");
    expect(lines).toContain("Workflow PR: #99 (open)");
  });

  it("shows ticket blockers and needs-disposition worker detail without making up history", () => {
    const lines = detailLines(ticketRowKey(44));

    expect(lines).toContain("Readiness: blocked");
    expect(lines).toContain("Blockers: #43");
    expect(lines).toContain("Worker attempts:");
    expect(lines).toContain("  r1: needs-disposition");
    expect(lines).toContain("  Status: needs-disposition");
    expect(lines).toContain("  Model: anthropic/claude-sonnet-4:medium");
    expect(lines).toContain("  Process: gone");
    expect(lines).toContain("  Worktree: /workspaces/42/ticket-44/r1");
    expect(lines).not.toContain(expect.stringMatching(/turns:|last turn:/));
  });

  it("shows CI and Integration context on their respective tickets", () => {
    const ciLines = detailLines(ticketRowKey(45));
    expect(ciLines).toContain("Readiness: awaiting CI");
    expect(ciLines).toContain("CI: #45 r1 (failure)");
    expect(ciLines).toContain("CI integration branch: matt-auto/42/integration");
    expect(ciLines).toContain("CI summary: ci / test failed");
    expect(ciLines).toContain("CI URL: https://example.test/ci/45");

    const integrationLines = detailLines(ticketRowKey(46));
    expect(integrationLines).toContain("Integration: #46 r3 (pending-retry)");
    expect(integrationLines).toContain(
      "Integration branch: matt-auto/42/integration",
    );
    expect(integrationLines).toContain(
      "Integration reason: Local verification failed",
    );
  });

  it("represents a ticket with no active worker without inventing worker telemetry", () => {
    const lines = detailLines(ticketRowKey(47));

    expect(lines).toContain("Readiness: ready");
    expect(lines).toContain("Worker: no active attempt in this panel snapshot");
    expect(lines.join("\n")).not.toMatch(/PID:|Telemetry:|Worktree:/);
  });

  it("preserves a stable selection across refreshed telemetry and falls back deterministically when removed", () => {
    const initialPanel = basePanel({
      workers: [
        {
          ticketNumber: 43,
          attempt: 1,
          status: "running",
          progress: "Compiling",
          branchName: "matt-auto/42/ticket-43/r1",
        },
      ],
      ticketProgress: {
        workflowId: 42,
        total: 1,
        open: 1,
        closed: 0,
        ready: [{ number: 43, title: "Selected ticket" }],
        blocked: [],
        awaitingCi: [],
        items: [
          {
            number: 43,
            title: "Selected ticket",
            state: "OPEN",
            status: "ready",
          },
        ],
      },
    });
    const initial = buildWorkflowDashboardViewModel(
      { panel: initialPanel, preflight: preflight(), nextActions: actions() },
      { selectedKey: workerAttemptRowKey(43, 1), nowMs: 1_700_000_000_000 },
    );

    const refreshed = buildWorkflowDashboardViewModel(
      {
        panel: {
          ...initialPanel,
          workers: [
            {
              ...initialPanel.workers[0]!,
              progress: "Running tests",
              turnCount: 5,
            },
          ],
        },
        preflight: preflight(),
        nextActions: actions(),
      },
      { selectedKey: initial.selectedKey, nowMs: 1_700_000_000_000 },
    );
    expect(refreshed.selectedKey).toBe(workerAttemptRowKey(43, 1));
    expect(refreshed.selectedDetail.lines).toContain("Progress: Running tests");
    expect(refreshed.selectedDetail.lines).toContain("Telemetry: turns: 5 · last turn: —");

    const removed = buildWorkflowDashboardViewModel(
      {
        panel: { ...initialPanel, workers: [] },
        preflight: preflight(),
        nextActions: actions(),
      },
      { selectedKey: refreshed.selectedKey, nowMs: 1_700_000_000_000 },
    );
    expect(removed.rows.some((row) => row.key === refreshed.selectedKey)).toBe(
      false,
    );
    expect(removed.selectedKey).toBe(WORKFLOW_DASHBOARD_WORKFLOW_ROW_KEY);
  });

  it("exposes Switch/take-over routing instead of Worker settings", () => {
    const vm = buildWorkflowDashboardViewModel(
      { panel: fullPanel(), preflight: preflight(), nextActions: actions() },
      { nowMs: 1_700_000_065_000 },
    );

    const switchRow = vm.rows.find((row) => row.key === switchWorkflowRowKey());
    expect(switchRow?.kind).toBe("routing");
    expect(switchRow?.label).toBe("Switch / take over workflow…");
    expect(switchRow?.detail.lines.join("\n")).toMatch(/take over/i);
    expect(vm.rows.some((row) => row.label.includes("Configure Worker"))).toBe(false);

    const nextOnly = buildWorkflowDashboardViewModel(
      { panel: fullPanel(), preflight: preflight(), nextActions: actions() },
      { scope: "next-actions" },
    );
    expect(nextOnly.rows.some((row) => row.key === switchWorkflowRowKey())).toBe(
      false,
    );
  });

  it("preserves an action selection by action id when its rendered copy changes", () => {
    const selected = buildWorkflowDashboardViewModel(
      { preflight: preflight(), nextActions: actions() },
      { selectedKey: nextActionRowKey("implement:43") },
    );
    const refreshed = buildWorkflowDashboardViewModel(
      {
        preflight: preflight(),
        nextActions: [
          {
            id: "implement:43",
            label: "Implement ticket #43 now",
            description: "Updated coordinator copy.",
          },
        ],
      },
      { selectedKey: selected.selectedKey },
    );

    expect(refreshed.selectedKey).toBe(nextActionRowKey("implement:43"));
    expect(refreshed.selectedDetail.title).toBe(
      "Next action: Implement ticket #43 now",
    );
  });
});
