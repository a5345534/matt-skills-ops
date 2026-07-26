import { describe, expect, it, vi } from "vitest";
import { WORKER_CONCURRENCY_WARNING_THRESHOLD } from "../src/constants.js";
import {
  buildMainMenuItems,
  concurrencyWarningMessage,
  confirmConcurrencyWarning,
  formatResolvedWorkerConcurrencyLine,
  formatTicketProgressLines,
  needsConcurrencyWarning,
  parseTicketsDraftFromEditor,
  parseWorkerConcurrencyInput,
  presentWorkerConcurrencyMenu,
  promptWorkerConcurrency,
  selectAvailableModel,
  selectPipelineAction,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  AvailableModel,
  PreflightResult,
  TicketProgressSummary,
  WorkflowCoordinator,
  WorkflowRoot,
} from "../src/types.js";

const availableRoot: WorkflowRoot = {
  path: "/repo",
  kind: "nearest",
  status: "available",
};

const preflightWithProfile: PreflightResult = {
  ok: true,
  targetBranch: "main",
  checks: [
    {
      id: "worker-profile",
      ok: true,
      guidance:
        "Worker profile is set (anthropic/claude-sonnet-4, thinking medium, source global).",
    },
  ],
  workerProfile: {
    profile: {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "medium",
    },
    source: "global",
  },
};

describe("buildMainMenuItems", () => {
  it("surfaces the effective Worker profile and a configure action", () => {
    const items = buildMainMenuItems(
      preflightWithProfile,
      [],
      availableRoot,
      1,
    );

    expect(items).toContain("--- Worker profile ---");
    expect(items).toContain(
      "Effective: anthropic/claude-sonnet-4 (thinking medium) [global]",
    );
    expect(items).toContain("Configure Worker profile…");
    expect(items).toContain("Configure Worker concurrency…");
  });

  it("surfaces effective Worker concurrency and source when provided", () => {
    const items = buildMainMenuItems(
      preflightWithProfile,
      [],
      availableRoot,
      1,
      undefined,
      undefined,
      { concurrency: 3, source: "global" },
    );

    expect(items).toContain("--- Worker concurrency ---");
    expect(items).toContain("Effective Worker concurrency: 3 [global]");
    expect(items).toContain("Configure Worker concurrency…");
  });

  it("surfaces ticket-progress summary lines when frontier data is present", () => {
    const progress: TicketProgressSummary = {
      workflowId: 42,
      total: 3,
      open: 2,
      closed: 1,
      ready: [{ number: 10, title: "Ready A" }],
      blocked: [{ number: 11, title: "Blocked B", openBlockers: [10] }],
      awaitingCi: [],
      items: [
        {
          number: 10,
          title: "Ready A",
          state: "OPEN",
          status: "ready",
        },
        {
          number: 11,
          title: "Blocked B",
          state: "OPEN",
          status: "blocked",
          openBlockers: [10],
        },
      ],
    };
    const items = buildMainMenuItems(
      preflightWithProfile,
      [],
      availableRoot,
      1,
      progress,
    );

    expect(items).toContain("--- Ticket progress ---");
    expect(items).toContain(
      "Tickets: 1 ready / 2 open / 1 closed (total 3)",
    );
    expect(items.some((line) => line.includes("#10 Ready A"))).toBe(true);
  });
});

describe("parseTicketsDraftFromEditor", () => {
  it("parses a multi-ticket breakdown with blockedBy edges", () => {
    const draft = parseTicketsDraftFromEditor(`
1 | First ready ticket | blockedBy: none
## What to build

Core path.

---
2 | Dependent ticket | blockedBy: 1
## What to build

Depends on core.
`);

    expect(draft).toEqual({
      tickets: [
        {
          localId: "1",
          title: "First ready ticket",
          body: "## What to build\n\nCore path.",
          blockedBy: [],
        },
        {
          localId: "2",
          title: "Dependent ticket",
          body: "## What to build\n\nDepends on core.",
          blockedBy: ["1"],
        },
      ],
    });
  });
});

describe("formatTicketProgressLines", () => {
  it("formats ready frontier and blocked tickets", () => {
    const lines = formatTicketProgressLines({
      workflowId: 1,
      total: 2,
      open: 2,
      closed: 0,
      ready: [{ number: 3, title: "A" }],
      blocked: [{ number: 4, title: "B", openBlockers: [3] }],
      awaitingCi: [],
      items: [
        { number: 3, title: "A", state: "OPEN", status: "ready" },
        {
          number: 4,
          title: "B",
          state: "OPEN",
          status: "blocked",
          openBlockers: [3],
        },
      ],
    });

    expect(lines[0]).toMatch(/1 ready \/ 2 open \/ 0 closed/);
    expect(lines[1]).toMatch(/#3 A/);
    expect(lines[2]).toMatch(/#4 \(by #3\)/);
  });
});

describe("selectAvailableModel", () => {
  const models: AvailableModel[] = [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      label: "anthropic/claude-sonnet-4 — Sonnet",
      thinkingLevels: ["off", "medium", "high"],
    },
    {
      provider: "openai",
      modelId: "gpt-4o",
      label: "openai/gpt-4o",
      thinkingLevels: ["off"],
    },
  ];

  it("shows the full catalog first, with Search as an explicit option", async () => {
    const selectCalls: string[][] = [];
    const ui: MattAutoUi = {
      input: async () => {
        throw new Error("input should not be required to pick a model");
      },
      select: async (_title, options) => {
        selectCalls.push([...options]);
        // Skip the search item; pick the first real model.
        return options.find((o) => o.includes("claude-sonnet-4"));
      },
      notify: () => {},
    };

    const chosen = await selectAvailableModel(models, ui);

    expect(chosen).toEqual(models[0]);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.[0]).toMatch(/Search models/);
    expect(selectCalls[0]?.some((o) => o.includes("gpt-4o"))).toBe(true);
  });

  it("offers the Workflow home model as the first option when provided", async () => {
    const selectCalls: string[][] = [];
    const home = {
      provider: "openai",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
      label: "openai/gpt-5.6-terra",
      thinkingLevels: ["off", "medium", "high"] as const,
    };
    const ui: MattAutoUi = {
      input: async () => undefined,
      select: async (_title, options) => {
        selectCalls.push([...options]);
        return options[0];
      },
      notify: () => {},
    };

    const chosen = await selectAvailableModel(models, ui, home);

    expect(selectCalls[0]?.[0]).toMatch(/Use Workflow home model/);
    expect(selectCalls[0]?.[0]).toMatch(/gpt-5.6-terra/);
    expect(chosen).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      label: "openai/gpt-5.6-terra",
      thinkingLevels: ["off", "medium", "high"],
    });
  });

  it("filters the catalog when Search is chosen, then selects a model", async () => {
    let selectRound = 0;
    const selectCalls: string[][] = [];
    const ui: MattAutoUi = {
      input: async () => "sonnet",
      select: async (_title, options) => {
        selectCalls.push([...options]);
        selectRound += 1;
        if (selectRound === 1) return options[0]; // Search models…
        return options.find((o) => o.includes("claude-sonnet-4"));
      },
      notify: () => {},
    };

    const chosen = await selectAvailableModel(models, ui);

    expect(chosen).toEqual(models[0]);
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[1]).toHaveLength(2); // Search item + one match
    expect(selectCalls[1]?.some((o) => o.includes("claude-sonnet-4"))).toBe(
      true,
    );
    expect(selectCalls[1]?.some((o) => o.includes("gpt-4o"))).toBe(false);
  });

  it("restores the full catalog when the search matches nothing", async () => {
    let selectRound = 0;
    const notices: string[] = [];
    const ui: MattAutoUi = {
      input: async () => "no-such-model",
      select: async (_title, options) => {
        selectRound += 1;
        if (selectRound === 1) return options[0]; // Search models…
        // After empty search, full catalog is shown again.
        expect(options.some((o) => o.includes("gpt-4o"))).toBe(true);
        return options.find((o) => o.includes("gpt-4o"));
      },
      notify: (message) => {
        notices.push(message);
      },
    };

    const chosen = await selectAvailableModel(models, ui);
    expect(chosen).toEqual(models[1]);
    expect(notices[0]).toMatch(/No models matched/i);
  });

  it("works without ui.input by listing models directly", async () => {
    const ui: MattAutoUi = {
      select: async (_title, options) => options[0],
      notify: () => {},
    };

    const chosen = await selectAvailableModel(models, ui);
    expect(chosen).toEqual(models[0]);
  });
});

describe("Worker concurrency configure helpers", () => {
  it("formats effective Worker concurrency with source", () => {
    expect(formatResolvedWorkerConcurrencyLine(2, "default")).toBe(
      "Effective Worker concurrency: 2 [default]",
    );
    expect(formatResolvedWorkerConcurrencyLine(5, "workflow-root")).toBe(
      "Effective Worker concurrency: 5 [workflow-root]",
    );
  });

  it("flags Concurrency warning only above the threshold", () => {
    expect(needsConcurrencyWarning(1)).toBe(false);
    expect(needsConcurrencyWarning(4)).toBe(false);
    expect(needsConcurrencyWarning(5)).toBe(true);
    expect(needsConcurrencyWarning(WORKER_CONCURRENCY_WARNING_THRESHOLD)).toBe(
      false,
    );
    expect(
      needsConcurrencyWarning(WORKER_CONCURRENCY_WARNING_THRESHOLD + 1),
    ).toBe(true);
  });

  it("uses glossary terms in the Concurrency warning message", () => {
    const message = concurrencyWarningMessage(8);
    expect(message).toMatch(/Concurrency warning/);
    expect(message).toMatch(/Worker concurrency 8/);
    expect(message).toMatch(/warning threshold of 4/);
    expect(message).toMatch(/no Matt Auto hard upper limit/);
    expect(message).toMatch(/will not re-prompt/);
  });

  it("parses positive integer Worker concurrency and rejects invalid input", () => {
    expect(parseWorkerConcurrencyInput("3")).toEqual({ ok: true, value: 3 });
    expect(parseWorkerConcurrencyInput(" 12 ")).toEqual({
      ok: true,
      value: 12,
    });
    expect(parseWorkerConcurrencyInput("1")).toEqual({ ok: true, value: 1 });

    expect(parseWorkerConcurrencyInput("")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("0")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("-2")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("1.5")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("2e1")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("abc")).toMatchObject({ ok: false });
    expect(parseWorkerConcurrencyInput("3x")).toMatchObject({ ok: false });

    const invalid = parseWorkerConcurrencyInput("nope");
    if (invalid.ok) throw new Error("expected invalid");
    expect(invalid.reason).toMatch(/positive integer/i);
    expect(invalid.reason).toMatch(/Worker concurrency/);
  });
});

describe("promptWorkerConcurrency", () => {
  it("saves N ≤ 4 without a Concurrency warning confirm", async () => {
    const selects: string[] = [];
    const notifies: Array<{ message: string; type?: string }> = [];
    const ui: MattAutoUi = {
      input: async () => "3",
      select: async (_title, options) => {
        selects.push(...options);
        return options[0];
      },
      notify: (message, type) => {
        notifies.push(type === undefined ? { message } : { message, type });
      },
    };

    await expect(promptWorkerConcurrency(ui, "global default")).resolves.toBe(
      3,
    );
    expect(selects).toHaveLength(0);
    expect(notifies.some((n) => /Concurrency warning/.test(n.message))).toBe(
      false,
    );
  });

  it("requires Concurrency warning confirm for N > 4 and saves on confirm", async () => {
    const ui: MattAutoUi = {
      input: async () => "8",
      select: async (title, options) => {
        expect(title).toBe("Concurrency warning");
        expect(options[0]).toMatch(/Confirm Worker concurrency/);
        return options[0];
      },
      notify: (message, type) => {
        if (type === "warning") {
          expect(message).toMatch(/Concurrency warning/);
          expect(message).toMatch(/Worker concurrency 8/);
        }
      },
    };

    await expect(promptWorkerConcurrency(ui, "global default")).resolves.toBe(
      8,
    );
  });

  it("decline of Concurrency warning leaves no value to write", async () => {
    const notifies: string[] = [];
    const ui: MattAutoUi = {
      input: async () => "9",
      select: async (_title, options) =>
        options.find((o) => o === "Cancel") ?? options[1],
      notify: (message) => {
        notifies.push(message);
      },
    };

    await expect(
      promptWorkerConcurrency(ui, "Workflow-root override"),
    ).resolves.toBeUndefined();
    expect(notifies.some((m) => /declined/.test(m))).toBe(true);
    expect(notifies.some((m) => /unchanged/.test(m))).toBe(true);
  });

  it("notifies a clear validation error for invalid input and does not confirm", async () => {
    const notifies: Array<{ message: string; type?: string }> = [];
    let selectCalled = false;
    const ui: MattAutoUi = {
      input: async () => "1.5",
      select: async () => {
        selectCalled = true;
        return undefined;
      },
      notify: (message, type) => {
        notifies.push(type === undefined ? { message } : { message, type });
      },
    };

    await expect(
      promptWorkerConcurrency(ui, "global default"),
    ).resolves.toBeUndefined();
    expect(selectCalled).toBe(false);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.type).toBe("error");
    expect(notifies[0]?.message).toMatch(/positive integer/i);
  });

  it("boundary N = 4 saves without warning; N = 5 requires warning", async () => {
    let warningSelects = 0;
    const uiAtThreshold: MattAutoUi = {
      input: async () => "4",
      select: async () => {
        warningSelects += 1;
        return "Confirm Worker concurrency";
      },
      notify: () => {},
    };
    await expect(
      promptWorkerConcurrency(uiAtThreshold, "global default"),
    ).resolves.toBe(4);
    expect(warningSelects).toBe(0);

    const uiAbove: MattAutoUi = {
      input: async () => "5",
      select: async () => "Confirm Worker concurrency",
      notify: () => {},
    };
    await expect(
      promptWorkerConcurrency(uiAbove, "global default"),
    ).resolves.toBe(5);
  });
});

describe("confirmConcurrencyWarning", () => {
  it("returns true only when Confirm Worker concurrency is selected", async () => {
    await expect(
      confirmConcurrencyWarning(
        {
          select: async () => "Confirm Worker concurrency",
          notify: () => {},
        },
        7,
      ),
    ).resolves.toBe(true);

    await expect(
      confirmConcurrencyWarning(
        {
          select: async () => "Cancel",
          notify: () => {},
        },
        7,
      ),
    ).resolves.toBe(false);
  });
});

describe("presentWorkerConcurrencyMenu", () => {
  function fakeCoordinator(initial?: {
    global?: number;
    root?: number;
  }): WorkflowCoordinator & {
    store: { global?: number; root?: number };
  } {
    const store: { global?: number; root?: number } = {};
    if (initial?.global !== undefined) store.global = initial.global;
    if (initial?.root !== undefined) store.root = initial.root;
    const coordinator = {
      store,
      getGlobalWorkerConcurrency: async () => store.global,
      getRootWorkerConcurrency: async () => store.root,
      setGlobalWorkerConcurrency: async (n: number) => {
        store.global = n;
      },
      setRootWorkerConcurrency: async (n: number) => {
        store.root = n;
      },
      clearRootWorkerConcurrency: async () => {
        delete store.root;
      },
    };
    return coordinator as unknown as WorkflowCoordinator & {
      store: { global?: number; root?: number };
    };
  }

  it("sets global and root concurrency from the menu", async () => {
    const coordinator = fakeCoordinator();
    const inputs = ["3", "2"];
    const selections = [
      "Set global default Worker concurrency",
      "Set Workflow-root Worker concurrency override",
      "← Back",
    ];
    const ui: MattAutoUi = {
      input: async () => inputs.shift(),
      select: async (_title, _options) => selections.shift(),
      notify: () => {},
    };

    await presentWorkerConcurrencyMenu(coordinator, ui);
    expect(coordinator.store.global).toBe(3);
    expect(coordinator.store.root).toBe(2);
  });

  it("clears root override so effective falls back to global/default", async () => {
    const coordinator = fakeCoordinator({ global: 3, root: 8 });
    const selections = [
      "Clear Workflow-root Worker concurrency override",
      "← Back",
    ];
    const notifies: string[] = [];
    const ui: MattAutoUi = {
      select: async (_title, options) => {
        // Clear option only present while root is set.
        if (selections[0] === "Clear Workflow-root Worker concurrency override") {
          expect(options).toContain(
            "Clear Workflow-root Worker concurrency override",
          );
        }
        return selections.shift();
      },
      notify: (message) => {
        notifies.push(message);
      },
    };

    await presentWorkerConcurrencyMenu(coordinator, ui);
    expect(coordinator.store.root).toBeUndefined();
    expect(coordinator.store.global).toBe(3);
    expect(notifies.some((m) => /falls back to the global default/.test(m))).toBe(
      true,
    );
  });

  it("does not write when Concurrency warning is declined", async () => {
    const coordinator = fakeCoordinator({ global: 2 });
    const selections = [
      "Set global default Worker concurrency",
      "Cancel", // decline Concurrency warning
      "← Back",
    ];
    const ui: MattAutoUi = {
      input: async () => "10",
      select: async (_title, options) => {
        const next = selections.shift();
        if (next === "Cancel") {
          expect(options).toContain("Cancel");
        }
        return next;
      },
      notify: () => {},
    };

    await presentWorkerConcurrencyMenu(coordinator, ui);
    expect(coordinator.store.global).toBe(2);
  });

  it("rejects invalid input without mutating preferences", async () => {
    const coordinator = fakeCoordinator({ global: 2 });
    const setSpy = vi.spyOn(coordinator, "setGlobalWorkerConcurrency");
    const selections = [
      "Set global default Worker concurrency",
      "← Back",
    ];
    const notifies: Array<{ message: string; type?: string }> = [];
    const ui: MattAutoUi = {
      input: async () => "0",
      select: async () => selections.shift(),
      notify: (message, type) => {
        notifies.push(type === undefined ? { message } : { message, type });
      },
    };

    await presentWorkerConcurrencyMenu(coordinator, ui);
    expect(setSpy).not.toHaveBeenCalled();
    expect(coordinator.store.global).toBe(2);
    expect(notifies.some((n) => n.type === "error")).toBe(true);
  });
});

describe("selectPipelineAction", () => {
  it("auto-picks the first frontier implement ticket without asking", () => {
    const chosen = selectPipelineAction([
      {
        id: "implement-ticket:12",
        label: "Implement #12",
        description: "A",
      },
      {
        id: "implement-ticket:15",
        label: "Implement #15",
        description: "B",
      },
      {
        id: "ticket-progress",
        label: "Ticket progress: 2 ready / 2 open / 0 closed",
        description: "Ready frontier: #12, #15.",
      },
    ]);
    expect(chosen?.id).toBe("implement-ticket:12");
  });

  it("never auto-selects ticket-progress alone", () => {
    const chosen = selectPipelineAction([
      {
        id: "ticket-progress",
        label: "Ticket progress: 0 ready / 3 open / 0 closed",
        description: "Ready frontier: none.",
      },
    ]);
    expect(chosen).toBeUndefined();
  });

  it("prefers in-flight implement over starting a new Create-spec", () => {
    const chosen = selectPipelineAction([
      {
        id: "implement-ticket:12",
        label: "Implement #12",
        description: "A",
      },
      {
        id: "create-spec",
        label: "Create spec",
        description: "S",
      },
    ]);
    expect(chosen?.id).toBe("implement-ticket:12");
  });

  it("never auto-selects Rework (operator-only; prevents close→rework loops)", () => {
    const withImplement = selectPipelineAction([
      {
        id: "implement-ticket:282",
        label: "Implement #282",
        description: "dependent",
      },
      {
        id: "rework-ticket:281",
        label: "Rework #281",
        description: "blocker",
      },
    ]);
    expect(withImplement?.id).toBe("implement-ticket:282");

    const reworkOnly = selectPipelineAction([
      {
        id: "rework-ticket:281",
        label: "Rework #281",
        description: "blocker",
      },
      {
        id: "ticket-progress",
        label: "Ticket progress",
        description: "info",
      },
    ]);
    expect(reworkOnly).toBeUndefined();
  });

  it("does not auto-pick Create-spec when Start Follow-up is also offered (post-cleanup)", () => {
    const chosen = selectPipelineAction([
      {
        id: "create-spec",
        label: "Create spec",
        description: "S",
      },
      {
        id: "start-follow-up",
        label: "Start Follow-up workflow",
        description: "F",
      },
    ]);
    expect(chosen).toBeUndefined();
  });

  it("still auto-picks Create-spec when it is the only actionable next step", () => {
    const chosen = selectPipelineAction([
      {
        id: "create-spec",
        label: "Create spec",
        description: "S",
      },
      {
        id: "ticket-progress",
        label: "Ticket progress",
        description: "info",
      },
    ]);
    expect(chosen?.id).toBe("create-spec");
  });
});
