import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelsPort } from "../ports.js";
import type { AvailableModel, HomeModelSelection } from "../types.js";

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

/** Live Workflow home model selection from the Pi session. */
export type HomeModelSource = {
  provider: string;
  id: string;
  thinkingLevel: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
};

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

async function loadAvailableModels(
  modelRegistry: ModelRegistry,
): Promise<AvailableModel[]> {
  // refresh() reloads models.json and rebuilds the availability snapshot.
  // getAvailable() is a sync snapshot — it can still be empty if auth
  // checks have not populated configuredProviders yet.
  await modelRegistry.refresh();

  let models = modelRegistry.getAvailable();
  if (models.length === 0) {
    models = modelRegistry
      .getAll()
      .filter((model) => modelRegistry.hasConfiguredAuth(model));
  }
  if (models.length === 0) {
    // Last resort: surface the full catalog so the user can still pick.
    // Request-time auth may still succeed even if the snapshot is empty.
    models = modelRegistry.getAll();
  }

  return models
    .map((model) => toAvailableModel(model))
    .sort((a, b) =>
      `${a.provider}/${a.modelId}`.localeCompare(
        `${b.provider}/${b.modelId}`,
      ),
    );
}

/**
 * ModelsPort backed by Pi’s ModelRegistry.
 * Reads the authenticated available-model catalog only; never selects a model
 * for Workflow home.
 */
export function createModelsPort(
  modelRegistry: ModelRegistry,
  getHomeModelSource?: () => HomeModelSource | undefined,
): ModelsPort {
  return {
    async listAvailableModels() {
      return loadAvailableModels(modelRegistry);
    },

    async getHomeModel() {
      const home = getHomeModelSource?.();
      if (!home?.provider || !home.id) return undefined;

      const thinkingLevel =
        typeof home.thinkingLevel === "string" && home.thinkingLevel.length > 0
          ? home.thinkingLevel
          : "off";

      const catalog = await loadAvailableModels(modelRegistry);
      const match = catalog.find(
        (model) =>
          model.provider === home.provider && model.modelId === home.id,
      );

      const thinkingLevels =
        match?.thinkingLevels ??
        thinkingLevelsForModel({
          ...(home.reasoning !== undefined
            ? { reasoning: home.reasoning }
            : {}),
          ...(home.thinkingLevelMap
            ? { thinkingLevelMap: home.thinkingLevelMap }
            : {}),
        });

      // Prefer catalog label; fall back to live home model metadata.
      const label =
        match?.label ??
        (home.name
          ? `${home.provider}/${home.id} — ${home.name}`
          : `${home.provider}/${home.id}`);

      return {
        provider: home.provider,
        modelId: home.id,
        thinkingLevel,
        label,
        thinkingLevels,
      } satisfies HomeModelSelection;
    },
  };
}
