import { describe, expect, it, vi } from "vitest";
import { createModelsPort } from "../src/adapters/models.js";

function fakeModel(provider: string, id: string, name?: string) {
  return {
    provider,
    id,
    name,
    reasoning: false,
  };
}

describe("createModelsPort", () => {
  it("uses getAvailable when the snapshot is populated", async () => {
    const available = [fakeModel("openai", "gpt-5.6-terra", "Terra")];
    const registry = {
      refresh: vi.fn(async () => {}),
      getAvailable: vi.fn(() => available),
      getAll: vi.fn(() => available),
      hasConfiguredAuth: vi.fn(() => true),
    };

    const port = createModelsPort(registry as never);
    const models = await port.listAvailableModels();

    expect(registry.refresh).toHaveBeenCalledOnce();
    expect(models).toEqual([
      {
        provider: "openai",
        modelId: "gpt-5.6-terra",
        label: "openai/gpt-5.6-terra — Terra",
        thinkingLevels: ["off"],
      },
    ]);
  });

  it("falls back to auth-configured models when the available snapshot is empty", async () => {
    const all = [
      fakeModel("openai", "gpt-5.6-terra"),
      fakeModel("anthropic", "claude-sonnet-4"),
    ];
    const registry = {
      refresh: vi.fn(async () => {}),
      getAvailable: vi.fn(() => []),
      getAll: vi.fn(() => all),
      hasConfiguredAuth: vi.fn(
        (model: { provider: string }) => model.provider === "openai",
      ),
    };

    const port = createModelsPort(registry as never);
    const models = await port.listAvailableModels();

    expect(models.map((m) => `${m.provider}/${m.modelId}`)).toEqual([
      "openai/gpt-5.6-terra",
    ]);
  });

  it("falls back to the full catalog when no auth-configured models are found", async () => {
    const all = [
      fakeModel("openai", "gpt-5.6-terra"),
      fakeModel("anthropic", "claude-sonnet-4"),
    ];
    const registry = {
      refresh: vi.fn(async () => {}),
      getAvailable: vi.fn(() => []),
      getAll: vi.fn(() => all),
      hasConfiguredAuth: vi.fn(() => false),
    };

    const port = createModelsPort(registry as never);
    const models = await port.listAvailableModels();

    expect(models.map((m) => m.modelId).sort()).toEqual([
      "claude-sonnet-4",
      "gpt-5.6-terra",
    ]);
  });

  it("exposes the live Workflow home model selection", async () => {
    const available = [
      {
        ...fakeModel("openai", "gpt-5.6-terra", "Terra"),
        reasoning: true,
      },
    ];
    const registry = {
      refresh: vi.fn(async () => {}),
      getAvailable: vi.fn(() => available),
      getAll: vi.fn(() => available),
      hasConfiguredAuth: vi.fn(() => true),
    };

    const port = createModelsPort(registry as never, () => ({
      provider: "openai",
      id: "gpt-5.6-terra",
      thinkingLevel: "high",
      name: "Terra",
      reasoning: true,
    }));

    await expect(port.getHomeModel()).resolves.toEqual({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "high",
      label: "openai/gpt-5.6-terra — Terra",
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });
  });
});
