import { describe, expect, it } from "vitest";
import {
  buildMainMenuItems,
  formatTicketProgressLines,
  parseTicketsDraftFromEditor,
  selectAvailableModel,
  selectPipelineAction,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  AvailableModel,
  PreflightResult,
  TicketProgressSummary,
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

  it("prefers create-spec over implement actions", () => {
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
    expect(chosen?.id).toBe("create-spec");
  });
});
