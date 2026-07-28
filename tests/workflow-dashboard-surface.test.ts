import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  NextAction,
  PreflightResult,
  TicketProgressSummary,
  WorkflowPanelState,
} from "../src/types.js";
import {
  presentWorkflowDashboard,
  type WorkflowDashboardComponent,
  type WorkflowDashboardCustomUi,
  type WorkflowDashboardResult,
  type WorkflowDashboardSnapshot,
  type WorkflowDashboardTheme,
  type WorkflowDashboardTui,
} from "../src/ui/workflow-dashboard.js";

const theme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
};

function preflight(): PreflightResult {
  return {
    ok: true,
    targetBranch: "main",
    checks: [],
  };
}

function progress(): TicketProgressSummary {
  return {
    workflowId: 42,
    total: 1,
    open: 1,
    closed: 0,
    ready: [{ number: 43, title: "Dashboard ticket" }],
    blocked: [],
    awaitingCi: [],
    items: [
      {
        number: 43,
        title: "Dashboard ticket",
        state: "OPEN",
        status: "ready",
      },
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
  ];
}

function panel(
  overrides: Partial<WorkflowPanelState> = {},
): WorkflowPanelState {
  return {
    workflowId: 42,
    title: "Persistent browser",
    lines: [],
    workers: [
      {
        ticketNumber: 43,
        attempt: 1,
        status: "running",
        branchName: "matt-auto/42/ticket-43/r1",
        processAlive: true,
        progress: "Compiling",
        turnCount: 1,
      },
    ],
    pipelinePaused: false,
    ...overrides,
  };
}

function snapshot(
  currentPanel: WorkflowPanelState = panel(),
): WorkflowDashboardSnapshot {
  return {
    panel: currentPanel,
    ticketProgress: progress(),
    preflight: preflight(),
    nextActions: actions(),
  };
}

function source(currentPanel: WorkflowPanelState = panel()) {
  return {
    preflight: vi.fn(async () => preflight()),
    nextActions: vi.fn(async () => actions()),
    getTicketProgress: vi.fn(async () => progress()),
    getPanelState: vi.fn(async () => currentPanel),
  };
}

type DashboardHarness = {
  ui: WorkflowDashboardCustomUi;
  requestRender: ReturnType<typeof vi.fn>;
  doneValues: WorkflowDashboardResult[];
  component: () => WorkflowDashboardComponent | undefined;
};

function dashboardHarness(): DashboardHarness {
  let captured: WorkflowDashboardComponent | undefined;
  let resolveResult: (() => void) | undefined;
  const requestRender = vi.fn();
  const doneValues: WorkflowDashboardResult[] = [];
  const ui: WorkflowDashboardCustomUi = {
    custom: async <T>(
      factory: (
        tui: WorkflowDashboardTui,
        theme: WorkflowDashboardTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => WorkflowDashboardComponent | Promise<WorkflowDashboardComponent>,
      _options?: { overlay?: boolean },
    ): Promise<T | undefined> => {
      let result: T | undefined;
      captured = await factory(
        { requestRender },
        theme,
        {},
        (value: T) => {
          result = value;
          doneValues.push(value as WorkflowDashboardResult);
          resolveResult?.();
        },
      );
      await new Promise<void>((resolve) => {
        resolveResult = resolve;
      });
      return result;
    },
  };

  return {
    ui,
    requestRender,
    doneValues,
    component: () => captured,
  };
}

async function capturedComponent(
  harness: DashboardHarness,
): Promise<WorkflowDashboardComponent> {
  for (let tick = 0; tick < 4; tick += 1) {
    const component = harness.component();
    if (component) return component;
    await Promise.resolve();
  }
  throw new Error("Dashboard custom component was not created");
}

function send(component: WorkflowDashboardComponent, input: string): void {
  expect(component.handleInput).toBeTypeOf("function");
  component.handleInput!(input);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("persistent workflow dashboard surface", () => {
  it("keeps passive ticket, worker, and action inspection in one custom component", async () => {
    const dashboardSource = source();
    const harness = dashboardHarness();
    const notify = vi.fn();
    const uiWithNotify = { ...harness.ui, notify };
    const opening = presentWorkflowDashboard(dashboardSource, uiWithNotify, {
      initialSnapshot: snapshot(),
      pollIntervalMs: 10_000,
    });
    const component = await capturedComponent(harness);

    const initial = component.render(120).join("\n");
    expect(initial).toContain("Workflow summary");
    expect(initial).toContain("Tickets · #43 — Dashboard ticket");
    expect(initial).toContain("Worker attempts · #43 r1 — running");
    expect(initial).toContain("Next actions · Implement #43");
    expect(initial).toContain("Esc return to chat");

    // Workflow → ticket. onSelectionChange updates detail without resolving.
    send(component, "\u001b[B");
    expect(component.render(120).join("\n")).toContain(
      "Selected · Ticket #43",
    );
    expect(harness.doneValues).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    // Ticket → worker. The worker inspection detail replaces the inline pane.
    send(component, "\u001b[B");
    const workerFrame = component.render(120).join("\n");
    expect(workerFrame).toContain("Selected · Worker #43 r1");
    expect(workerFrame).toContain("Progress: Compiling");
    expect(harness.doneValues).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    // Worker → action. Action rows remain inspectable until the later
    // dashboard-native action interaction slice owns their execution.
    send(component, "\u001b[B");
    expect(component.render(120).join("\n")).toContain(
      "Selected · Next action: Implement #43",
    );

    // Enter is still passive in this browsing slice, including on action rows.
    send(component, "\r");
    expect(harness.doneValues).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    send(component, "\u001b");
    await expect(opening).resolves.toEqual({ status: "dismissed" });
    expect(harness.doneValues).toEqual([{ status: "dismissed" }]);
  });

  it("polls only local panel telemetry and retains the selected worker key", async () => {
    vi.useFakeTimers();
    const initial = panel({
      workers: [
        {
          ticketNumber: 43,
          attempt: 1,
          status: "running",
          branchName: "matt-auto/42/ticket-43/r1",
          progress: "Compiling",
        },
      ],
    });
    const refreshed = panel({
      workers: [
        // A new earlier row proves retention is by stable key, not list index.
        {
          ticketNumber: 42,
          attempt: 1,
          status: "running",
          branchName: "matt-auto/42/ticket-42/r1",
          progress: "Starting",
        },
        {
          ticketNumber: 43,
          attempt: 1,
          status: "running",
          branchName: "matt-auto/42/ticket-43/r1",
          processAlive: true,
          progress: "Running tests",
          turnCount: 5,
        },
      ],
    });
    const dashboardSource = source(refreshed);
    const harness = dashboardHarness();
    const opening = presentWorkflowDashboard(dashboardSource, harness.ui, {
      initialSnapshot: snapshot(initial),
      pollIntervalMs: 25,
    });
    const component = await capturedComponent(harness);

    // Workflow → ticket → worker.
    send(component, "\u001b[B");
    send(component, "\u001b[B");
    expect(component.render(120).join("\n")).toContain("Worker #43 r1");

    await vi.advanceTimersByTimeAsync(25);

    expect(dashboardSource.getPanelState).toHaveBeenCalledTimes(1);
    expect(dashboardSource.getPanelState).toHaveBeenCalledWith({ mode: "local" });
    expect(dashboardSource.preflight).not.toHaveBeenCalled();
    expect(dashboardSource.nextActions).not.toHaveBeenCalled();
    expect(dashboardSource.getTicketProgress).not.toHaveBeenCalled();

    const refreshedFrame = component.render(120).join("\n");
    expect(refreshedFrame).toContain("Selected · Worker #43 r1");
    expect(refreshedFrame).toContain("Progress: Running tests");
    expect(refreshedFrame).toContain("Telemetry: turns: 5 · last turn: —");
    expect(harness.requestRender).toHaveBeenCalled();

    send(component, "\u001b");
    await expect(opening).resolves.toEqual({ status: "dismissed" });
  });

  it("uses r for the explicit full snapshot path and respects terminal width/theme invalidation", async () => {
    const dashboardSource = source(
      panel({
        workers: [],
        title: "A deliberately long workflow title that must fit narrow terminals",
      }),
    );
    const harness = dashboardHarness();
    const opening = presentWorkflowDashboard(dashboardSource, harness.ui, {
      initialSnapshot: snapshot(panel({ workers: [] })),
      pollIntervalMs: 10_000,
    });
    const component = await capturedComponent(harness);

    const beforeInvalidate = harness.requestRender.mock.calls.length;
    component.invalidate?.();
    expect(harness.requestRender.mock.calls.length).toBeGreaterThan(beforeInvalidate);

    for (const width of [1, 19]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }

    send(component, "r");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dashboardSource.preflight).toHaveBeenCalledTimes(1);
    expect(dashboardSource.nextActions).toHaveBeenCalledTimes(1);
    expect(dashboardSource.getTicketProgress).toHaveBeenCalledTimes(1);
    expect(dashboardSource.getPanelState).toHaveBeenCalledWith({ mode: "full" });
    expect(component.render(120).join("\n")).toContain(
      "A deliberately long workflow title",
    );

    send(component, "\u001b");
    await expect(opening).resolves.toEqual({ status: "dismissed" });
  });
});
