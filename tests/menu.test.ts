import { describe, expect, it } from "vitest";
import {
  buildMainMenuItems,
  selectAvailableModel,
  type MattAutoUi,
} from "../src/ui/menu.js";
import type {
  AvailableModel,
  PreflightResult,
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
