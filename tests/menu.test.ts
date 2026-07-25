import { describe, expect, it } from "vitest";
import {
  buildMainMenuItems,
  formatTicketProgressLines,
  parseTicketsDraftFromEditor,
  selectAvailableModel,
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

  it("filters the catalog with a search query then selects a model", async () => {
    const selections: string[] = [];
    const ui: MattAutoUi = {
      input: async () => "sonnet",
      select: async (_title, options) => {
        selections.push(...options);
        return options[0];
      },
      notify: () => {},
    };

    const chosen = await selectAvailableModel(models, ui);

    expect(chosen).toEqual(models[0]);
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatch(/claude-sonnet-4/);
    expect(selections[0]).not.toMatch(/gpt-4o/);
  });

  it("returns undefined when the filter matches nothing", async () => {
    const notices: string[] = [];
    const ui: MattAutoUi = {
      input: async () => "no-such-model",
      select: async () => {
        throw new Error("select should not be called");
      },
      notify: (message) => {
        notices.push(message);
      },
    };

    await expect(selectAvailableModel(models, ui)).resolves.toBeUndefined();
    expect(notices[0]).toMatch(/No models matched/i);
  });
});
