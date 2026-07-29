import { describe, expect, it, vi } from "vitest";
import {
  presentMainMenu,
  presentNextActions,
  runPostGrillPipeline,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  NextAction,
  PreflightResult,
  TicketProgressSummary,
  WorkflowCoordinator,
  WorkflowPanelState,
  WorkflowRoot,
} from "../src/types.js";
import type {
  WorkflowDashboardComponent,
  WorkflowDashboardTheme,
  WorkflowDashboardTui,
} from "../src/ui/workflow-dashboard.js";

const root: WorkflowRoot = {
  path: "/repo",
  kind: "nearest",
  status: "available",
};

const preflight: PreflightResult = {
  ok: true,
  targetBranch: "main",
  checks: [],
};

const nextActions: NextAction[] = [
  {
    id: "implement-ticket:43",
    label: "Implement #43",
    description: "Start the ready ticket.",
  },
];

const ticketProgress: TicketProgressSummary = {
  workflowId: 42,
  total: 1,
  open: 1,
  closed: 0,
  ready: [{ number: 43, title: "Route through dashboard" }],
  blocked: [],
  awaitingCi: [],
  items: [
    {
      number: 43,
      title: "Route through dashboard",
      state: "OPEN",
      status: "ready",
    },
  ],
};

const panel: WorkflowPanelState = {
  workflowId: 42,
  title: "Dashboard routing",
  lines: [],
  workers: [],
  pipelinePaused: false,
};

function coordinatorHarness() {
  return {
    preflight: vi.fn(async () => preflight),
    nextActions: vi.fn(async () => nextActions),
    getTicketProgress: vi.fn(async () => ticketProgress),
    getPanelState: vi.fn(async () => panel),
    runNextAction: vi.fn(async () => ({
      status: "cancelled" as const,
      stage: "create-spec" as const,
    })),
    confirmStage: vi.fn(async () => ({
      status: "cancelled" as const,
      stage: "create-spec" as const,
    })),
    confirmDisposition: vi.fn(async () => ({
      status: "cancelled" as const,
      stage: "implement" as const,
    })),
    currentRoot: vi.fn(async () => root),
    listRoots: vi.fn(async () => [root]),
    getWorkerProfile: vi.fn(async () => undefined),
    getGlobalWorkerProfile: vi.fn(async () => undefined),
    getRootWorkerProfile: vi.fn(async () => undefined),
    getActiveWorkflow: vi.fn(async () => undefined),
    setActiveWorkflowWorkerProfile: vi.fn(async () => undefined),
    listAvailableModels: vi.fn(async () => []),
    getHomeModel: vi.fn(async () => undefined),
    getGlobalWorkerConcurrency: vi.fn(async () => undefined),
    getRootWorkerConcurrency: vi.fn(async () => undefined),
    listLocalUnfinishedWorkflows: vi.fn(async () => [
      {
        workflowId: 38,
        sources: ["legacy-pointer" as const],
        bound: true,
        label: "Workflow #38 · bound",
      },
    ]),
    selectLocalUnfinishedWorkflow: vi.fn(async () => undefined),
  };
}

type CustomHarness = {
  ui: MattAutoUi & {
    selects: ReturnType<typeof vi.fn>;
    notices: string[];
  };
  component: () => WorkflowDashboardComponent | undefined;
};

function customHarness(): CustomHarness {
  let captured: WorkflowDashboardComponent | undefined;
  const notices: string[] = [];
  const selects = vi.fn(async () => undefined);
  const custom: NonNullable<MattAutoUi["custom"]> = async <T,>(
    factory: (
      tui: WorkflowDashboardTui,
      theme: WorkflowDashboardTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => WorkflowDashboardComponent | Promise<WorkflowDashboardComponent>,
    _options?: { overlay?: boolean },
  ): Promise<T | undefined> => {
    let resolveResult!: (value: T | undefined) => void;
    const result = new Promise<T | undefined>((resolve) => {
      resolveResult = resolve;
    });
    captured = await factory(
      { requestRender: () => undefined },
      {
        fg: (_color: unknown, text: string) => text,
        bold: (text: string) => text,
      },
      {},
      (value) => resolveResult(value),
    );
    return result;
  };

  return {
    ui: {
      select: selects,
      notify: (message) => {
        notices.push(message);
      },
      custom,
      selects,
      notices,
    },
    component: () => captured,
  };
}

async function capturedComponent(
  harness: CustomHarness,
): Promise<WorkflowDashboardComponent> {
  for (let tick = 0; tick < 20; tick += 1) {
    const component = harness.component();
    if (component) return component;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("dashboard was not opened");
}

function dismiss(component: WorkflowDashboardComponent): void {
  expect(component.handleInput).toBeTypeOf("function");
  component.handleInput!("\u001b");
}

describe("manual menu dashboard routing", () => {
  it("opens a local-only home first, then drills into the GitHub dashboard", async () => {
    const coordinator = coordinatorHarness();
    const mainHarness = customHarness();
    // 1) Home select unfinished · 2) Open this workflow · 3) after Esc, cancel home
    mainHarness.ui.selects
      .mockResolvedValueOnce("Workflow #38 · bound [#38]")
      .mockResolvedValueOnce("Open this workflow")
      .mockResolvedValueOnce(undefined);

    const mainOpening = presentMainMenu(
      coordinator as unknown as WorkflowCoordinator,
      mainHarness.ui,
    );

    await vi.waitFor(() => {
      expect(mainHarness.ui.selects).toHaveBeenCalledWith(
        "Matt Auto",
        expect.arrayContaining([
          "Settings…",
          "--- Unfinished (local) ---",
          "Workflow #38 · bound [#38]",
        ]),
      );
      expect(mainHarness.ui.selects).toHaveBeenCalledWith(
        "Workflow #38",
        expect.arrayContaining([
          "Open this workflow",
          "Take over this workflow…",
          "Switch / take over another Active workflow…",
        ]),
      );
    });
    // Home lists local unfinished before any GitHub-backed snapshot path.
    expect(coordinator.listLocalUnfinishedWorkflows).toHaveBeenCalled();
    expect(coordinator.selectLocalUnfinishedWorkflow).toHaveBeenCalledWith(38);
    expect(
      coordinator.listLocalUnfinishedWorkflows.mock.invocationCallOrder[0],
    ).toBeLessThan(coordinator.preflight.mock.invocationCallOrder[0] ?? Infinity);

    const main = await capturedComponent(mainHarness);
    expect(main.render(120).join("\n")).toContain(
      "Matt Auto · Workflow dashboard",
    );
    dismiss(main);
    await expect(mainOpening).resolves.toBeUndefined();

    const nextHarness = customHarness();
    const nextOpening = presentNextActions(
      coordinator as unknown as WorkflowCoordinator,
      nextHarness.ui,
    );
    const next = await capturedComponent(nextHarness);
    const nextFrame = next.render(120).join("\n");

    expect(nextFrame).toContain("Matt Auto · Next actions");
    expect(nextFrame).toContain("Next actions · Implement #43");
    expect(nextFrame).not.toContain("Tickets · #43");
    expect(nextFrame).not.toContain("Preflight ·");
    expect(nextHarness.ui.selects).not.toHaveBeenCalled();
    dismiss(next);
    await expect(nextOpening).resolves.toBeUndefined();
  });

  it("retains blocking select menus when custom is absent or rejects", async () => {
    const coordinator = coordinatorHarness();
    const selects = vi.fn(async () => undefined);
    const fallbackUi: MattAutoUi = {
      select: selects,
      notify: () => {},
    };

    await presentMainMenu(coordinator as unknown as WorkflowCoordinator, fallbackUi);
    expect(selects).toHaveBeenCalledWith(
      "Matt Auto",
      expect.arrayContaining(["Settings…"]),
    );

    selects.mockClear();
    await presentNextActions(coordinator as unknown as WorkflowCoordinator, fallbackUi);
    expect(selects).toHaveBeenCalledWith(
      "Matt Auto Next actions",
      expect.any(Array),
    );

    const rejectedSelects = vi.fn(async () => undefined);
    const partialUi: MattAutoUi = {
      select: rejectedSelects,
      notify: () => {},
      custom: (async () => {
        throw new Error("custom TUI unavailable");
      }) as NonNullable<MattAutoUi["custom"]>,
    };
    await presentMainMenu(coordinator as unknown as WorkflowCoordinator, partialUi);
    expect(rejectedSelects).toHaveBeenCalledWith("Matt Auto", expect.any(Array));
  });

  it("keeps /matt-auto run on its existing non-dashboard pipeline path", async () => {
    const custom = vi.fn() as unknown as NonNullable<MattAutoUi["custom"]>;
    const ui: MattAutoUi = {
      select: async () => undefined,
      notify: () => {},
      custom,
    };
    const coordinator = {
      beginPipelineRun: vi.fn(),
      isRunTerminated: vi.fn(() => false),
      isPipelinePaused: vi.fn(() => false),
      preflight: vi.fn(async () => preflight),
      nextActions: vi.fn(async () => []),
      getPanelState: vi.fn(async () => undefined),
    };

    await runPostGrillPipeline(coordinator as unknown as WorkflowCoordinator, ui);

    // `custom()` remains reserved for the live run brief when the pipeline is
    // actually waiting; this idle run never opens the manual dashboard.
    expect(custom).not.toHaveBeenCalled();
  });
});
