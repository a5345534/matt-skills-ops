import { describe, expect, it } from "vitest";
import { thinkingLevelsForModel } from "../src/adapters/models.js";

describe("thinkingLevelsForModel", () => {
  it("returns only off when the model has no reasoning support", () => {
    expect(thinkingLevelsForModel({ reasoning: false })).toEqual(["off"]);
    expect(thinkingLevelsForModel({})).toEqual(["off"]);
  });

  it("returns standard levels for a reasoning model", () => {
    expect(thinkingLevelsForModel({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("hides levels mapped to null and includes xhigh/max only when mapped", () => {
    expect(
      thinkingLevelsForModel({
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          xhigh: "xhigh",
          max: "max",
        },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});
