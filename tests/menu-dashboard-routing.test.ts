import { describe, expect, it, vi } from "vitest";
import {
  presentMainMenu,
  presentNextActions,
  runPostGrillPipeline,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  LocalUnfinishedWorkflow,
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
    listLocalUnfinishedWorkflows: vi.fn(
      async (): Promise<LocalUnfinishedWorkflow[]> => [
        {
          workflowId: 38,
          sources: ["legacy-pointer"],
          bound: true,
          label: "Workflow #38 · bound",
        },
      ],
    ),
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
  it("opens a local-only home first; Open runs delivery (not the dashboard)", async () => {
    const coordinator = coordinatorHarness();
    const beginPipelineRun = vi.fn();
    const runCoordinator = {
      ...coordinator,
      beginPipelineRun,
      isRunTerminated: vi.fn(() => false),
      isPipelinePaused: vi.fn(() => false),
      nextActions: vi.fn(async () => []),
      getPanelState: vi.fn(async () => undefined),
    };
    const mainHarness = customHarness();
    // 1) Home select unfinished · 2) Open this workflow (run) · pipeline idles
    mainHarness.ui.selects
      .mockResolvedValueOnce("Workflow #38 · bound [#38]")
      .mockResolvedValueOnce("Open this workflow (run)");

    await presentMainMenu(
      runCoordinator as unknown as WorkflowCoordinator,
      mainHarness.ui,
    );

    expect(mainHarness.ui.selects).toHaveBeenCalledWith(
      "Matt Auto",
      expect.arrayContaining([
        "Settings…",
        "--- Unfinished (local) ---",
        "Workflow #38 · bound [#38]",
        "Start new workflow",
      ]),
    );
    expect(mainHarness.ui.selects).toHaveBeenCalledWith(
      "Workflow #38",
      expect.arrayContaining([
        "Open this workflow (run)",
        "Open Workflow dashboard…",
        "Take over this workflow…",
        "Switch / take over another Active workflow…",
      ]),
    );
    // Home lists local unfinished before any GitHub-backed snapshot path.
    expect(runCoordinator.listLocalUnfinishedWorkflows).toHaveBeenCalled();
    expect(runCoordinator.selectLocalUnfinishedWorkflow).toHaveBeenCalledWith(38);
    // Open continues as /matt-auto run — never opens the Workflow dashboard custom surface.
    expect(beginPipelineRun).toHaveBeenCalled();
    expect(mainHarness.component()).toBeUndefined();

    // /matt-auto next still uses the Next-actions dashboard scope.
    const nextCoordinator = coordinatorHarness();
    const nextHarness = customHarness();
    const nextOpening = presentNextActions(
      nextCoordinator as unknown as WorkflowCoordinator,
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

  // Issue #55: Start new remains visible with and without local unfinished entries.
  describe("home Start new workflow visibility", () => {
    it("always offers Start new workflow when unfinished list is non-empty", async () => {
      const coordinator = coordinatorHarness();
      const selects = vi.fn(async () => undefined);
      const ui: MattAutoUi = { select: selects, notify: () => {} };

      await presentMainMenu(coordinator as unknown as WorkflowCoordinator, ui);

      expect(selects).toHaveBeenCalledWith("Matt Auto", [
        "Settings…",
        "--- Unfinished (local) ---",
        "Workflow #38 · bound [#38]",
        "Start new workflow",
      ]);
      // Home render stays local-only — no tracker/preflight reads yet.
      expect(coordinator.listLocalUnfinishedWorkflows).toHaveBeenCalled();
      expect(coordinator.preflight).not.toHaveBeenCalled();
      expect(coordinator.getActiveWorkflow).not.toHaveBeenCalled();
    });

    it("offers Start new alongside every unfinished entry when the list has multiple items", async () => {
      const coordinator = coordinatorHarness();
      const unfinished: LocalUnfinishedWorkflow[] = [
        {
          workflowId: 38,
          sources: ["legacy-pointer"],
          bound: true,
          label: "Workflow #38 · bound",
        },
        {
          workflowId: 41,
          sources: ["transcripts"],
          bound: false,
          label: "Workflow #41 · unbound",
        },
      ];
      coordinator.listLocalUnfinishedWorkflows.mockResolvedValueOnce(unfinished);
      const selects = vi.fn(async () => undefined);
      const ui: MattAutoUi = { select: selects, notify: () => {} };

      await presentMainMenu(coordinator as unknown as WorkflowCoordinator, ui);

      expect(selects).toHaveBeenCalledWith("Matt Auto", [
        "Settings…",
        "--- Unfinished (local) ---",
        "Workflow #38 · bound [#38]",
        "Workflow #41 · unbound [#41]",
        "Start new workflow",
      ]);
    });

    it("offers Start new workflow and empty hint when unfinished list is empty", async () => {
      const coordinator = coordinatorHarness();
      coordinator.listLocalUnfinishedWorkflows.mockResolvedValueOnce([]);
      const selects = vi.fn(async () => undefined);
      const ui: MattAutoUi = { select: selects, notify: () => {} };

      await presentMainMenu(coordinator as unknown as WorkflowCoordinator, ui);

      expect(selects).toHaveBeenCalledWith("Matt Auto", [
        "Settings…",
        "No local unfinished workflows",
        "Start new workflow",
      ]);
    });

    it("routes Start new workflow into the post-grill pipeline, not an unfinished id", async () => {
      const coordinator = {
        ...coordinatorHarness(),
        beginPipelineRun: vi.fn(),
        isRunTerminated: vi.fn(() => false),
        isPipelinePaused: vi.fn(() => false),
        isAutoAdvanceBlocked: vi.fn(() => false),
        // Empty next-actions ends the pipeline after preflight without more UI.
        nextActions: vi.fn(async () => []),
        getPanelState: vi.fn(async () => undefined),
      };
      const selects = vi
        .fn()
        .mockResolvedValueOnce("Start new workflow")
        .mockResolvedValueOnce(undefined);
      const ui: MattAutoUi = { select: selects, notify: () => {} };

      await presentMainMenu(coordinator as unknown as WorkflowCoordinator, ui);

      // Start new enters the pipeline without binding an unfinished id. Its
      // first action owns readiness; Home does not restore a global preflight.
      expect(coordinator.selectLocalUnfinishedWorkflow).not.toHaveBeenCalled();
      expect(coordinator.preflight).not.toHaveBeenCalled();
      expect(coordinator.beginPipelineRun).toHaveBeenCalled();
    });

    it("drills unfinished selection into the workflow submenu without binding yet", async () => {
      const coordinator = coordinatorHarness();
      const selects = vi
        .fn()
        .mockResolvedValueOnce("Workflow #38 · bound [#38]")
        .mockResolvedValueOnce(undefined); // leave workflow submenu
      const ui: MattAutoUi = { select: selects, notify: () => {} };

      await presentMainMenu(coordinator as unknown as WorkflowCoordinator, ui);

      expect(selects).toHaveBeenCalledWith(
        "Workflow #38",
        expect.arrayContaining([
          "Open this workflow (run)",
          "Open Workflow dashboard…",
          "Take over this workflow…",
          "Switch / take over another Active workflow…",
        ]),
      );
      // Binding only happens on Open; merely picking the unfinished row must not bind.
      expect(coordinator.selectLocalUnfinishedWorkflow).not.toHaveBeenCalled();
      expect(coordinator.preflight).not.toHaveBeenCalled();
    });
  });

  it("opens the Workflow dashboard only from the explicit dashboard menu item", async () => {
    const coordinator = coordinatorHarness();
    const mainHarness = customHarness();
    mainHarness.ui.selects
      .mockResolvedValueOnce("Workflow #38 · bound [#38]")
      .mockResolvedValueOnce("Open Workflow dashboard…")
      .mockResolvedValueOnce(undefined);

    const mainOpening = presentMainMenu(
      coordinator as unknown as WorkflowCoordinator,
      mainHarness.ui,
    );

    const main = await capturedComponent(mainHarness);
    expect(main.render(120).join("\n")).toContain(
      "Matt Auto · Workflow dashboard",
    );
    dismiss(main);
    await expect(mainOpening).resolves.toBeUndefined();
    expect(coordinator.selectLocalUnfinishedWorkflow).toHaveBeenCalledWith(38);
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
