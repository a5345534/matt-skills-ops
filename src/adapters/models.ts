import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelsPort } from "../ports.js";
import type { AvailableModel } from "../types.js";

const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevelMap = Partial<
  Record<(typeof EXTENDED_THINKING_LEVELS)[number], string | null>
>;

/**
 * Thinking levels supported by a Pi model, matching pi-ai’s rules:
 * - no reasoning → ["off"]
 * - reasoning models expose off..high unless mapped null
 * - xhigh/max only when thinkingLevelMap explicitly defines them
 */
export function thinkingLevelsForModel(model: {
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}): readonly string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function toAvailableModel(model: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}): AvailableModel {
  const label =
    typeof model.name === "string" && model.name.length > 0
      ? `${model.provider}/${model.id} — ${model.name}`
      : `${model.provider}/${model.id}`;
  return {
    provider: model.provider,
    modelId: model.id,
    label,
    thinkingLevels: thinkingLevelsForModel(model),
  };
}

/**
 * ModelsPort backed by Pi’s ModelRegistry.
 * Reads the authenticated available-model catalog only; never selects a model
 * for Workflow home.
 */
export function createModelsPort(modelRegistry: ModelRegistry): ModelsPort {
  return {
    async listAvailableModels() {
      await modelRegistry.refresh();
      const models = modelRegistry.getAvailable();
      return models
        .map((model) => toAvailableModel(model))
        .sort((a, b) =>
          `${a.provider}/${a.modelId}`.localeCompare(
            `${b.provider}/${b.modelId}`,
          ),
        );
    },
  };
}

